use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use polymarket_client_sdk::types::{Decimal, B256};
use serde::Serialize;

use crate::client::{PolymarketClient, RewardDetailSnapshot};
use crate::config;
use crate::filters::{filter_snapshot_eligible, reference_start_time};
use crate::models::{
    DashboardRow, MarketSnapshot, Opportunity, OpportunityReason, OpportunityStatus, PricingZone,
    RewardProgram, SortField,
};
use crate::scoring::{
    analyze_markets, human_duration, market_competitiveness_p90, sort_opportunities,
};

#[derive(Debug, Clone)]
pub struct SnapshotBuildConfig {
    pub quote_size_usdc: Decimal,
    pub min_queue_multiple: Decimal,
    pub min_apr: Decimal,
    pub tag: Option<String>,
    pub sort: SortField,
    pub limit: usize,
    pub dashboard_limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub meta: SnapshotMeta,
    pub available_tags: Vec<String>,
    pub dashboard: DashboardSnapshot,
    pub opportunities: SnapshotOpportunities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub generated_at: String,
    pub scan_duration_ms: u64,
    pub source_version: String,
    pub quote_size_usdc: Decimal,
    pub min_queue_multiple: Decimal,
    pub competitiveness_p90: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub rows: Vec<SnapshotDashboardRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOpportunities {
    pub neutral: SnapshotOpportunityDataset,
    pub extreme: SnapshotOpportunityDataset,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOpportunityDataset {
    pub rows: Vec<SnapshotOpportunityRow>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventTiming {
    Started,
    Upcoming,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDashboardRow {
    pub market_id: String,
    pub question: String,
    pub market_url: Option<String>,
    pub image: Option<String>,
    pub tags: Vec<String>,
    pub event_start_time: Option<String>,
    pub event_timing: EventTiming,
    pub time_to_start_human: Option<String>,
    pub reward_daily_rate: Decimal,
    pub rewards_max_spread: Decimal,
    pub rewards_min_size: Decimal,
    pub market_competitiveness: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOpportunityRow {
    pub market_id: String,
    pub question: String,
    pub market_url: Option<String>,
    pub image: Option<String>,
    pub tags: Vec<String>,
    pub side_to_trade: String,
    pub token_id: String,
    pub status: OpportunityStatus,
    pub reason: OpportunityReason,
    pub event_start_time: Option<String>,
    pub event_timing: EventTiming,
    pub time_to_start_human: Option<String>,
    pub reward_daily_rate: Decimal,
    pub rewards_max_spread: Decimal,
    pub rewards_min_size: Decimal,
    pub pricing_zone: Option<PricingZone>,
    pub market_competitiveness: Option<Decimal>,
    pub spread_ratio: Option<Decimal>,
    pub apr_ceiling: Option<Decimal>,
    pub raw_apr: Option<Decimal>,
    pub effective_apr: Option<Decimal>,
    pub apr_lower: Option<Decimal>,
    pub apr_upper: Option<Decimal>,
    pub two_sided_apr: Option<Decimal>,
    pub suggested_price: Option<Decimal>,
    pub suggested_price_lower: Option<Decimal>,
    pub suggested_price_upper: Option<Decimal>,
    pub queue_multiple: Option<Decimal>,
}

#[derive(Debug, Clone)]
struct MarketUiMetadata {
    market_url: Option<String>,
    image: Option<String>,
    tags: Vec<String>,
    reference_start_time: Option<DateTime<Utc>>,
}

pub async fn build_snapshot(
    client: &PolymarketClient,
    config: &SnapshotBuildConfig,
) -> Result<Snapshot> {
    let started_at = Instant::now();
    let generated_started_at = Utc::now();
    let source_version = format!("napolyrewardfarmor/{}", env!("CARGO_PKG_VERSION"));

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

    let mut dashboard_rewards = rewards.clone();
    if let Some(tag) = config.tag.as_deref() {
        dashboard_rewards.retain(|reward| {
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

    dashboard_rewards.sort_by(|left, right| {
        right
            .reward_daily_rate
            .cmp(&left.reward_daily_rate)
            .then_with(|| left.condition_id.cmp(&right.condition_id))
    });
    dashboard_rewards.truncate(config.dashboard_limit);

    let dashboard_detail_ids: Vec<_> = dashboard_rewards
        .iter()
        .map(|reward| reward.condition_id)
        .collect();
    let reward_details = client.fetch_reward_details(&dashboard_detail_ids).await;

    let mut eligible = filter_snapshot_eligible(
        &rewards,
        &markets,
        config.tag.as_deref(),
        generated_started_at,
    );
    eligible.sort_by(|left, right| {
        right
            .reward
            .reward_daily_rate
            .cmp(&left.reward.reward_daily_rate)
            .then_with(|| left.event_start_time.cmp(&right.event_start_time))
            .then_with(|| left.reward.condition_id.cmp(&right.reward.condition_id))
    });

    let book_shortlist_size = std::cmp::max(
        config
            .limit
            .saturating_mul(config::BOOK_SHORTLIST_MULTIPLIER),
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

    let mut preliminary = analyze_markets(
        &eligible,
        &books,
        config.quote_size_usdc,
        config.min_queue_multiple,
        true,
        None,
    );
    sort_opportunities(&mut preliminary, config.sort);

    let competitiveness_shortlist_size = std::cmp::max(
        config
            .limit
            .saturating_mul(config::COMPETITIVENESS_SHORTLIST_MULTIPLIER),
        config::COMPETITIVENESS_SHORTLIST_MIN,
    );
    let shortlisted_condition_ids: HashSet<String> = preliminary
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
    let competitiveness_p90 = market_competitiveness_p90(
        &eligible
            .iter()
            .map(|market| market.reward.clone())
            .collect::<Vec<_>>(),
    );

    let mut all = analyze_markets(
        &eligible,
        &books,
        config.quote_size_usdc,
        config.min_queue_multiple,
        true,
        competitiveness_p90,
    );
    sort_opportunities(&mut all, config.sort);

    let mut neutral: Vec<_> = all
        .iter()
        .filter(|o| o.pricing_zone == Some(PricingZone::Neutral))
        .cloned()
        .collect();
    neutral.retain(|opportunity| {
        opportunity.status != OpportunityStatus::CandidateNow
            || opportunity
                .apr_effective
                .map(|apr| apr >= config.min_apr)
                .unwrap_or(false)
    });
    neutral.truncate(config.limit);

    let mut extreme: Vec<_> = all
        .iter()
        .filter(|o| o.pricing_zone == Some(PricingZone::Extreme))
        .cloned()
        .collect();
    extreme.retain(|opportunity| {
        opportunity.status != OpportunityStatus::CandidateNow
            || opportunity
                .two_sided_apr
                .map(|apr| apr >= config.min_apr)
                .unwrap_or(false)
    });
    extreme.truncate(config.limit);

    let market_metadata = build_market_metadata_map(&markets);
    let generated_at = Utc::now();
    let dashboard_rows =
        build_dashboard_rows(&dashboard_rewards, &reward_details, &markets, generated_at);
    let neutral_rows = build_opportunity_rows(&neutral, &market_metadata, generated_at);
    let extreme_rows = build_opportunity_rows(&extreme, &market_metadata, generated_at);

    Ok(Snapshot {
        meta: SnapshotMeta {
            generated_at: generated_at.to_rfc3339(),
            scan_duration_ms: started_at.elapsed().as_millis() as u64,
            source_version,
            quote_size_usdc: config.quote_size_usdc,
            min_queue_multiple: config.min_queue_multiple,
            competitiveness_p90,
        },
        available_tags: collect_available_tags(&markets),
        dashboard: DashboardSnapshot {
            rows: dashboard_rows,
        },
        opportunities: SnapshotOpportunities {
            neutral: SnapshotOpportunityDataset { rows: neutral_rows },
            extreme: SnapshotOpportunityDataset { rows: extreme_rows },
        },
    })
}

fn build_dashboard_rows(
    rewards: &[RewardProgram],
    reward_details: &HashMap<B256, RewardDetailSnapshot>,
    markets: &HashMap<B256, MarketSnapshot>,
    now: DateTime<Utc>,
) -> Vec<SnapshotDashboardRow> {
    rewards
        .iter()
        .map(|reward| {
            let detail = reward_details.get(&reward.condition_id);
            let market = markets.get(&reward.condition_id);
            let display_time = market.and_then(reference_start_time);
            let event_timing = classify_event_timing(display_time, now);

            let row = DashboardRow {
                market_id: reward.condition_id.to_string(),
                question: detail
                    .and_then(|detail| detail.question.clone())
                    .unwrap_or_else(|| {
                        market
                            .map(|market| market.question.clone())
                            .unwrap_or_else(|| reward.condition_id.to_string())
                    }),
                market_url: market
                    .and_then(|market| {
                        build_polymarket_market_url(
                            market.event_slug.as_deref(),
                            market.market_slug.as_deref(),
                        )
                    })
                    .or_else(|| {
                        detail.and_then(|detail| {
                            build_polymarket_market_url(None, detail.market_slug.as_deref())
                        })
                    }),
                event_start_time: display_time.map(|value| value.to_rfc3339()),
                reward_daily_rate: reward.reward_daily_rate,
                rewards_max_spread: detail
                    .and_then(|detail| detail.rewards_max_spread)
                    .unwrap_or(reward.rewards_max_spread),
                rewards_min_size: detail
                    .and_then(|detail| detail.rewards_min_size)
                    .unwrap_or(reward.rewards_min_size),
                market_competitiveness: detail
                    .and_then(|detail| detail.market_competitiveness)
                    .or(reward.market_competitiveness),
            };

            SnapshotDashboardRow {
                market_id: row.market_id,
                question: row.question,
                market_url: row.market_url,
                image: market.and_then(|market| market.image.clone()),
                tags: market.map(flatten_tags).unwrap_or_default(),
                event_start_time: row.event_start_time,
                event_timing,
                time_to_start_human: display_time
                    .map(|value| human_duration((value - now).num_seconds())),
                reward_daily_rate: row.reward_daily_rate,
                rewards_max_spread: row.rewards_max_spread,
                rewards_min_size: row.rewards_min_size,
                market_competitiveness: row.market_competitiveness,
            }
        })
        .collect()
}

fn build_opportunity_rows(
    opportunities: &[Opportunity],
    market_metadata: &HashMap<String, MarketUiMetadata>,
    now: DateTime<Utc>,
) -> Vec<SnapshotOpportunityRow> {
    opportunities
        .iter()
        .map(|opportunity| {
            let metadata = market_metadata.get(&opportunity.market_id);
            let display_time = metadata.and_then(|metadata| metadata.reference_start_time);
            let event_timing = classify_event_timing(display_time, now);

            SnapshotOpportunityRow {
                market_id: opportunity.market_id.clone(),
                question: opportunity.question.clone(),
                market_url: metadata.and_then(|metadata| metadata.market_url.clone()),
                image: metadata.and_then(|metadata| metadata.image.clone()),
                tags: metadata
                    .map(|metadata| metadata.tags.clone())
                    .unwrap_or_default(),
                side_to_trade: opportunity.side_to_trade.clone(),
                token_id: opportunity.token_id.clone(),
                status: opportunity.status,
                reason: opportunity.reason,
                event_start_time: display_time.map(|value| value.to_rfc3339()),
                event_timing,
                time_to_start_human: display_time
                    .map(|value| human_duration((value - now).num_seconds())),
                reward_daily_rate: opportunity.reward_daily_rate,
                rewards_max_spread: opportunity.rewards_max_spread,
                rewards_min_size: opportunity.rewards_min_size,
                pricing_zone: opportunity.pricing_zone,
                market_competitiveness: opportunity.market_competitiveness,
                spread_ratio: opportunity.spread_ratio,
                apr_ceiling: opportunity.apr_ceiling,
                raw_apr: opportunity.apr_estimated,
                effective_apr: opportunity.apr_effective,
                apr_lower: opportunity.apr_lower,
                apr_upper: opportunity.apr_upper,
                two_sided_apr: opportunity.two_sided_apr,
                suggested_price: opportunity.suggested_price,
                suggested_price_lower: opportunity.suggested_price_lower,
                suggested_price_upper: opportunity.suggested_price_upper,
                queue_multiple: opportunity.liquidity_info.queue_multiple,
            }
        })
        .collect()
}

fn build_market_metadata_map(
    markets: &HashMap<B256, MarketSnapshot>,
) -> HashMap<String, MarketUiMetadata> {
    markets
        .iter()
        .map(|(condition_id, market)| {
            (
                condition_id.to_string(),
                MarketUiMetadata {
                    market_url: build_polymarket_market_url(
                        market.event_slug.as_deref(),
                        market.market_slug.as_deref(),
                    ),
                    image: market.image.clone(),
                    tags: flatten_tags(market),
                    reference_start_time: reference_start_time(market),
                },
            )
        })
        .collect()
}

fn flatten_tags(market: &MarketSnapshot) -> Vec<String> {
    market
        .tags
        .iter()
        .filter_map(|tag| {
            tag.label
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    tag.slug
                        .as_ref()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                })
        })
        .collect()
}

fn build_polymarket_market_url(
    event_slug: Option<&str>,
    market_slug: Option<&str>,
) -> Option<String> {
    let slug = event_slug
        .and_then(normalize_slug)
        .or_else(|| market_slug.and_then(normalize_slug))?;
    Some(format!("https://polymarket.com/event/{slug}"))
}

fn normalize_slug(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn collect_available_tags(markets: &HashMap<B256, MarketSnapshot>) -> Vec<String> {
    let mut tags: Vec<_> = markets
        .values()
        .flat_map(flatten_tags)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    tags.sort();
    tags
}

fn classify_event_timing(reference_time: Option<DateTime<Utc>>, now: DateTime<Utc>) -> EventTiming {
    match reference_time {
        Some(time) if time <= now => EventTiming::Started,
        _ => EventTiming::Upcoming,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};
    use polymarket_client_sdk::types::{dec, B256, U256};

    use super::{
        build_opportunity_rows, build_polymarket_market_url, classify_event_timing, EventTiming,
        MarketUiMetadata, SnapshotMeta, SnapshotOpportunityRow,
    };
    use crate::models::{
        LiquidityInfo, Opportunity, OpportunityReason, OpportunityStatus, PricingZone,
    };

    #[test]
    fn classifies_started_and_upcoming_from_reference_time() {
        let now = Utc.with_ymd_and_hms(2026, 4, 17, 12, 0, 0).unwrap();
        assert_eq!(
            classify_event_timing(
                Some(Utc.with_ymd_and_hms(2026, 4, 17, 11, 0, 0).unwrap()),
                now
            ),
            EventTiming::Started
        );
        assert_eq!(
            classify_event_timing(
                Some(Utc.with_ymd_and_hms(2026, 4, 17, 13, 0, 0).unwrap()),
                now
            ),
            EventTiming::Upcoming
        );
    }

    #[test]
    fn opportunity_rows_use_market_reference_time_for_timing() {
        let now = Utc.with_ymd_and_hms(2026, 4, 17, 12, 0, 0).unwrap();
        let opportunity = Opportunity {
            market_id: B256::ZERO.to_string(),
            question: "Question".to_string(),
            side_to_trade: "YES".to_string(),
            token_id: U256::from(1u64).to_string(),
            status: OpportunityStatus::CandidateNow,
            reason: OpportunityReason::InBand,
            event_start_time: Utc
                .with_ymd_and_hms(2026, 4, 18, 12, 0, 0)
                .unwrap()
                .to_rfc3339(),
            time_to_start_seconds: 86_400,
            time_to_start_human: "1d 0h".to_string(),
            reward_daily_rate: dec!(5),
            rewards_max_spread: dec!(3.5),
            rewards_min_size: dec!(50),
            pricing_zone: Some(PricingZone::Neutral),
            market_competitiveness: Some(dec!(1)),
            spread_ratio: Some(dec!(0.5)),
            apr_ceiling: Some(dec!(100)),
            apr_estimated: Some(dec!(25)),
            apr_effective: Some(dec!(8.33)),
            apr_lower: Some(dec!(12)),
            apr_upper: Some(dec!(80)),
            two_sided_apr: Some(dec!(25)),
            suggested_price: Some(dec!(0.48)),
            suggested_price_lower: Some(dec!(0.465)),
            suggested_price_upper: Some(dec!(0.50)),
            liquidity_info: LiquidityInfo {
                best_bid: Some(dec!(0.47)),
                best_ask: Some(dec!(0.49)),
                adjusted_midpoint: Some(dec!(0.48)),
                tick_size: dec!(0.01),
                reward_floor_price: Some(dec!(0.45)),
                suggested_price: Some(dec!(0.48)),
                queue_ahead_shares: Some(dec!(100)),
                queue_ahead_notional: Some(dec!(48)),
                queue_multiple: Some(dec!(2.5)),
                qualifying_depth_shares: Some(dec!(500)),
                distance_to_ask: Some(dec!(0.01)),
                current_spread: Some(dec!(0.02)),
            },
        };

        let rows = build_opportunity_rows(
            &[opportunity],
            &HashMap::from([(
                B256::ZERO.to_string(),
                MarketUiMetadata {
                    market_url: Some(
                        "https://polymarket.com/event/question-event".to_string(),
                    ),
                    image: Some("https://example.com/image.png".to_string()),
                    tags: vec!["Energy".to_string()],
                    reference_start_time: Some(
                        Utc.with_ymd_and_hms(2026, 4, 17, 11, 30, 0).unwrap(),
                    ),
                },
            )]),
            now,
        );

        assert_eq!(rows[0].event_timing, EventTiming::Started);
        assert_eq!(rows[0].time_to_start_human.as_deref(), Some("started"));
        assert_eq!(
            rows[0].market_url.as_deref(),
            Some("https://polymarket.com/event/question-event")
        );
    }

    #[test]
    fn market_url_prefers_event_slug_over_market_slug() {
        assert_eq!(
            build_polymarket_market_url(
                Some("which-company-has-the-best-ai-model-end-of-april"),
                Some("will-anthropic-have-the-best-ai-model-at-the-end-of-april-2026"),
            )
            .as_deref(),
            Some("https://polymarket.com/event/which-company-has-the-best-ai-model-end-of-april")
        );
    }

    #[test]
    fn snapshot_serialization_includes_quote_size_and_reward_rules() {
        let meta = SnapshotMeta {
            generated_at: "2026-04-23T08:00:00Z".to_string(),
            scan_duration_ms: 1000,
            source_version: "napolyrewardfarmor/test".to_string(),
            quote_size_usdc: dec!(1000),
            min_queue_multiple: dec!(2),
            competitiveness_p90: Some(dec!(1.5)),
        };
        let row = SnapshotOpportunityRow {
            market_id: B256::ZERO.to_string(),
            question: "Question".to_string(),
            market_url: Some("https://polymarket.com/event/question-event".to_string()),
            image: None,
            tags: vec!["AI".to_string()],
            side_to_trade: "Yes".to_string(),
            token_id: U256::from(1u64).to_string(),
            status: OpportunityStatus::CandidateNow,
            reason: OpportunityReason::InBand,
            event_start_time: Some("2026-04-24T08:00:00Z".to_string()),
            event_timing: EventTiming::Upcoming,
            time_to_start_human: Some("1d 0h".to_string()),
            reward_daily_rate: dec!(5),
            rewards_max_spread: dec!(3.5),
            rewards_min_size: dec!(50),
            pricing_zone: Some(PricingZone::Neutral),
            market_competitiveness: Some(dec!(1)),
            spread_ratio: Some(dec!(0.5)),
            apr_ceiling: Some(dec!(100)),
            raw_apr: Some(dec!(25)),
            effective_apr: Some(dec!(8.33)),
            apr_lower: Some(dec!(12)),
            apr_upper: Some(dec!(80)),
            two_sided_apr: Some(dec!(25)),
            suggested_price: Some(dec!(0.48)),
            suggested_price_lower: Some(dec!(0.465)),
            suggested_price_upper: Some(dec!(0.50)),
            queue_multiple: Some(dec!(2.5)),
        };

        let meta_json = serde_json::to_value(meta).unwrap();
        let row_json = serde_json::to_value(row).unwrap();

        assert_eq!(meta_json.get("quoteSizeUsdc").and_then(|value| value.as_str()), Some("1000"));
        assert_eq!(
            row_json.get("rewardsMaxSpread").and_then(|value| value.as_str()),
            Some("3.5")
        );
        assert_eq!(
            row_json.get("rewardsMinSize").and_then(|value| value.as_str()),
            Some("50")
        );
    }
}
