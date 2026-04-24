use std::collections::HashSet;

use anyhow::Result;
use chrono::Utc;
use clap::Parser;
use models::{DashboardRow, OpportunityStatus, SortField};
use polymarket_lp_reward_scanner::{
    client::PolymarketClient, config, display, filters, models, scoring,
};
use rust_decimal::Decimal;

#[derive(Debug, Parser)]
#[command(name = "polymarket-lp-reward-scanner")]
#[command(
    about = "Scan Polymarket reward markets for low-fill-risk one-sided quoting opportunities."
)]
struct Args {
    #[arg(long)]
    quote_size_usdc: Decimal,

    #[arg(long, default_value_t = config::DEFAULT_MIN_HOURS)]
    min_hours: u64,

    #[arg(long, default_value = config::DEFAULT_MIN_QUEUE_MULTIPLE)]
    min_queue_multiple: Decimal,

    #[arg(long, default_value = config::DEFAULT_MIN_APR)]
    min_apr: Decimal,

    #[arg(long)]
    tag: Option<String>,

    #[arg(long)]
    two_sided: bool,

    #[arg(long)]
    dashboard: bool,

    #[arg(long, value_enum, default_value_t = SortField::Apr)]
    sort: SortField,

    #[arg(long, default_value_t = config::DEFAULT_LIMIT)]
    limit: usize,

    #[arg(long)]
    json: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let client = PolymarketClient::new()?;

    if args.dashboard {
        let mut rewards = client.fetch_current_rewards_all().await?;
        if let Some(tag) = args.tag.as_deref() {
            let unique_condition_ids: Vec<_> = rewards
                .iter()
                .map(|reward| reward.condition_id)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let markets = client
                .fetch_markets_by_condition_ids(&unique_condition_ids)
                .await?;
            rewards.retain(|reward| {
                markets
                    .get(&reward.condition_id)
                    .map(|market| {
                        market.tags.iter().any(|market_tag| {
                            market_tag
                                .slug
                                .as_deref()
                                .map(|slug| slug.eq_ignore_ascii_case(tag))
                                .unwrap_or(false)
                                || market_tag
                                    .label
                                    .as_deref()
                                    .map(|label| label.eq_ignore_ascii_case(tag))
                                    .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            });
        }

        rewards.sort_by(|left, right| {
            right
                .reward_daily_rate
                .cmp(&left.reward_daily_rate)
                .then_with(|| left.condition_id.cmp(&right.condition_id))
        });
        rewards.truncate(args.limit);

        let details = client
            .fetch_reward_details(
                &rewards
                    .iter()
                    .map(|reward| reward.condition_id)
                    .collect::<Vec<_>>(),
            )
            .await;

        let rows: Vec<DashboardRow> = rewards
            .into_iter()
            .map(|reward| {
                let detail = details.get(&reward.condition_id);
                DashboardRow {
                    market_id: reward.condition_id.to_string(),
                    question: detail
                        .and_then(|detail| detail.question.clone())
                        .unwrap_or_else(|| reward.condition_id.to_string()),
                    market_url: None,
                    event_start_time: None,
                    reward_daily_rate: reward.reward_daily_rate,
                    rewards_max_spread: detail
                        .and_then(|detail| detail.rewards_max_spread)
                        .unwrap_or(reward.rewards_max_spread),
                    rewards_min_size: detail
                        .and_then(|detail| detail.rewards_min_size)
                        .unwrap_or(reward.rewards_min_size),
                    market_competitiveness: detail.and_then(|detail| detail.market_competitiveness),
                }
            })
            .collect();

        if args.json {
            display::print_dashboard_json(&rows)?;
        } else {
            display::print_dashboard_table(&rows);
        }

        return Ok(());
    }

    let rewards = client.fetch_current_rewards_all().await?;
    let unique_condition_ids: Vec<_> = rewards
        .iter()
        .map(|reward| reward.condition_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let markets = client
        .fetch_markets_by_condition_ids(&unique_condition_ids)
        .await?;

    let eligible = filters::filter_eligible(
        &rewards,
        &markets,
        args.min_hours,
        args.tag.as_deref(),
        Utc::now(),
    );
    let mut eligible = eligible;
    eligible.sort_by(|left, right| {
        right
            .reward
            .reward_daily_rate
            .cmp(&left.reward.reward_daily_rate)
            .then_with(|| left.event_start_time.cmp(&right.event_start_time))
            .then_with(|| left.reward.condition_id.cmp(&right.reward.condition_id))
    });

    let book_shortlist_size = std::cmp::max(
        args.limit.saturating_mul(config::BOOK_SHORTLIST_MULTIPLIER),
        config::BOOK_SHORTLIST_MIN,
    );
    if eligible.len() > book_shortlist_size {
        eligible.truncate(book_shortlist_size);
    }

    let token_ids: Vec<_> = eligible
        .iter()
        .flat_map(|market| market.market.tokens.iter().map(|token| token.token_id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let books = client.fetch_order_books(&token_ids).await?;

    let mut preliminary = scoring::analyze_markets(
        &eligible,
        &books,
        args.quote_size_usdc,
        args.min_queue_multiple,
        args.two_sided,
        None,
    );
    scoring::sort_opportunities(&mut preliminary, args.sort);

    let competitiveness_shortlist_size = std::cmp::max(
        args.limit
            .saturating_mul(config::COMPETITIVENESS_SHORTLIST_MULTIPLIER),
        config::COMPETITIVENESS_SHORTLIST_MIN,
    );
    let shortlisted_condition_ids: HashSet<_> = preliminary
        .iter()
        .take(competitiveness_shortlist_size)
        .map(|opportunity| opportunity.market_id.clone())
        .collect();

    let mut eligible: Vec<_> = eligible
        .into_iter()
        .filter(|market| {
            shortlisted_condition_ids.contains(&market.reward.condition_id.to_string())
        })
        .collect();
    let competitiveness = client
        .fetch_market_competitiveness(
            &eligible
                .iter()
                .map(|market| market.reward.condition_id)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>(),
        )
        .await;
    for market in &mut eligible {
        market.reward.market_competitiveness = competitiveness
            .get(&market.reward.condition_id)
            .cloned()
            .flatten();
    }
    let competitiveness_p90 = scoring::market_competitiveness_p90(
        &eligible
            .iter()
            .map(|market| market.reward.clone())
            .collect::<Vec<_>>(),
    );

    let mut opportunities = scoring::analyze_markets(
        &eligible,
        &books,
        args.quote_size_usdc,
        args.min_queue_multiple,
        args.two_sided,
        competitiveness_p90,
    );
    opportunities.retain(|opportunity| {
        opportunity.status != OpportunityStatus::CandidateNow
            || opportunity
                .apr_effective
                .map(|apr| apr >= args.min_apr)
                .unwrap_or(false)
    });
    scoring::sort_opportunities(&mut opportunities, args.sort);
    opportunities.truncate(args.limit);

    if args.json {
        display::print_json(&opportunities)?;
    } else {
        display::print_table(&opportunities, args.two_sided);
    }

    Ok(())
}
