use chrono::{DateTime, Duration, Utc};

use crate::models::{EligibleMarket, MarketSnapshot, RewardProgram};

pub fn filter_eligible(
    rewards: &[RewardProgram],
    markets: &std::collections::HashMap<polymarket_client_sdk::types::B256, MarketSnapshot>,
    min_hours: u64,
    tag: Option<&str>,
    now: DateTime<Utc>,
) -> Vec<EligibleMarket> {
    let cutoff = now + Duration::hours(min_hours as i64);

    rewards
        .iter()
        .filter_map(|reward| {
            let market = markets.get(&reward.condition_id)?;
            let eligible = structural_eligible_market(reward, market, tag, now, false)?;
            if eligible.event_start_time <= cutoff {
                return None;
            }
            Some(eligible)
        })
        .collect()
}

pub fn filter_snapshot_eligible(
    rewards: &[RewardProgram],
    markets: &std::collections::HashMap<polymarket_client_sdk::types::B256, MarketSnapshot>,
    tag: Option<&str>,
    now: DateTime<Utc>,
) -> Vec<EligibleMarket> {
    rewards
        .iter()
        .filter_map(|reward| {
            let market = markets.get(&reward.condition_id)?;
            structural_eligible_market(reward, market, tag, now, true)
        })
        .collect()
}

pub fn reference_start_time(market: &MarketSnapshot) -> Option<DateTime<Utc>> {
    market
        .event_start_time
        .or(market.game_start_time)
        .or_else(|| {
            market
                .first_event
                .as_ref()
                .and_then(|event| event.start_time)
        })
        .or(market.start_date)
        .or(market.end_date)
}

pub fn resolve_event_time(market: &MarketSnapshot, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let primary = reference_start_time(market);
    if let Some(primary) = primary {
        if primary > now {
            return Some(primary);
        }
    }

    match (market.start_date, market.end_date) {
        (Some(start_date), _) if start_date > now => Some(start_date),
        (Some(start_date), Some(end_date)) if start_date <= now && end_date > now => Some(end_date),
        (Some(start_date), _) => Some(start_date),
        (None, Some(end_date)) => Some(end_date),
        (None, None) => primary,
    }
}

fn matches_tag(market: &MarketSnapshot, requested_tag: &str) -> bool {
    let requested = requested_tag.to_ascii_lowercase();

    market.tags.iter().any(|tag| {
        tag.slug
            .as_deref()
            .map(|slug| slug.eq_ignore_ascii_case(&requested))
            .unwrap_or(false)
            || tag
                .label
                .as_deref()
                .map(|label| label.eq_ignore_ascii_case(&requested))
                .unwrap_or(false)
    })
}

fn structural_eligible_market(
    reward: &RewardProgram,
    market: &MarketSnapshot,
    tag: Option<&str>,
    now: DateTime<Utc>,
    allow_live_started: bool,
) -> Option<EligibleMarket> {
    if reward.reward_daily_rate <= polymarket_client_sdk::types::dec!(0)
        || reward.rewards_max_spread <= polymarket_client_sdk::types::dec!(0)
        || reward.rewards_min_size <= polymarket_client_sdk::types::dec!(0)
    {
        return None;
    }

    if market.closed == Some(true)
        || market.archived == Some(true)
        || market.accepting_orders != Some(true)
        || market.enable_order_book != Some(true)
        || market.active == Some(false)
        || market.tokens.len() != 2
    {
        return None;
    }

    if let Some(first_event) = &market.first_event {
        if first_event.ended == Some(true) || first_event.closed == Some(true) {
            return None;
        }
        if !allow_live_started && first_event.live == Some(true) {
            return None;
        }
    }

    if let Some(tag) = tag {
        if !matches_tag(market, tag) {
            return None;
        }
    }

    let event_start_time = resolve_event_time(market, now)?;

    Some(EligibleMarket {
        reward: reward.clone(),
        market: market.clone(),
        event_start_time,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};
    use polymarket_client_sdk::types::{dec, B256, U256};

    use super::{
        filter_eligible, filter_snapshot_eligible, reference_start_time, resolve_event_time,
    };
    use crate::models::{EventSummary, MarketSnapshot, MarketTag, OutcomeToken, RewardProgram};

    fn sample_market() -> MarketSnapshot {
        MarketSnapshot {
            condition_id: B256::ZERO,
            question: "Question".to_string(),
            image: None,
            market_slug: Some("question-market".to_string()),
            event_slug: Some("question-event".to_string()),
            tags: vec![MarketTag {
                slug: Some("nba".to_string()),
                label: Some("NBA".to_string()),
            }],
            tokens: vec![
                OutcomeToken {
                    token_id: U256::from(1u64),
                    outcome: "Yes".to_string(),
                },
                OutcomeToken {
                    token_id: U256::from(2u64),
                    outcome: "No".to_string(),
                },
            ],
            active: Some(true),
            accepting_orders: Some(true),
            enable_order_book: Some(true),
            closed: Some(false),
            archived: Some(false),
            start_date: Some(Utc.with_ymd_and_hms(2026, 4, 7, 12, 0, 0).unwrap()),
            end_date: Some(Utc.with_ymd_and_hms(2026, 4, 8, 12, 0, 0).unwrap()),
            game_start_time: Some(Utc.with_ymd_and_hms(2026, 4, 7, 13, 0, 0).unwrap()),
            event_start_time: Some(Utc.with_ymd_and_hms(2026, 4, 7, 14, 0, 0).unwrap()),
            first_event: Some(EventSummary {
                start_time: Some(Utc.with_ymd_and_hms(2026, 4, 7, 15, 0, 0).unwrap()),
                live: Some(false),
                ended: Some(false),
                closed: Some(false),
            }),
        }
    }

    #[test]
    fn resolves_event_time_in_priority_order() {
        let market = sample_market();
        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        assert_eq!(
            resolve_event_time(&market, now),
            Some(Utc.with_ymd_and_hms(2026, 4, 7, 14, 0, 0).unwrap())
        );
    }

    #[test]
    fn resolves_event_time_to_end_date_for_long_running_markets() {
        let mut market = sample_market();
        market.start_date = Some(Utc.with_ymd_and_hms(2026, 4, 1, 12, 0, 0).unwrap());
        market.game_start_time = None;
        market.event_start_time = None;
        market.first_event = None;

        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        assert_eq!(
            resolve_event_time(&market, now),
            Some(Utc.with_ymd_and_hms(2026, 4, 8, 12, 0, 0).unwrap())
        );
    }

    #[test]
    fn keeps_long_running_markets_eligible_when_end_date_is_future() {
        let reward = RewardProgram {
            condition_id: B256::ZERO,
            reward_daily_rate: dec!(2),
            rewards_min_size: dec!(50),
            rewards_max_spread: dec!(3.5),
            market_competitiveness: Some(dec!(1)),
        };
        let mut market = sample_market();
        market.start_date = Some(Utc.with_ymd_and_hms(2026, 4, 1, 12, 0, 0).unwrap());
        market.game_start_time = None;
        market.event_start_time = None;
        market.first_event = None;

        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        let mut markets = HashMap::new();
        markets.insert(B256::ZERO, market);

        let eligible = filter_eligible(&[reward], &markets, 1, None, now);
        assert_eq!(eligible.len(), 1);
        assert_eq!(
            eligible[0].event_start_time,
            Utc.with_ymd_and_hms(2026, 4, 8, 12, 0, 0).unwrap()
        );
    }

    #[test]
    fn ignores_past_nested_event_start_when_market_end_date_is_future() {
        let mut market = sample_market();
        market.start_date = Some(Utc.with_ymd_and_hms(2026, 4, 1, 12, 0, 0).unwrap());
        market.game_start_time = None;
        market.event_start_time = None;
        market.first_event = Some(EventSummary {
            start_time: Some(Utc.with_ymd_and_hms(2026, 4, 1, 12, 0, 0).unwrap()),
            live: Some(false),
            ended: Some(false),
            closed: Some(false),
        });

        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        assert_eq!(
            resolve_event_time(&market, now),
            Some(Utc.with_ymd_and_hms(2026, 4, 8, 12, 0, 0).unwrap())
        );
    }

    #[test]
    fn filters_by_cutoff_and_tag() {
        let reward = RewardProgram {
            condition_id: B256::ZERO,
            reward_daily_rate: dec!(2),
            rewards_min_size: dec!(50),
            rewards_max_spread: dec!(3.5),
            market_competitiveness: Some(dec!(1)),
        };
        let market = sample_market();
        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        let mut markets = HashMap::new();
        markets.insert(B256::ZERO, market);

        let eligible = filter_eligible(&[reward], &markets, 1, Some("nba"), now);
        assert_eq!(eligible.len(), 1);

        let skipped = filter_eligible(
            &[RewardProgram {
                condition_id: B256::ZERO,
                reward_daily_rate: dec!(2),
                rewards_min_size: dec!(50),
                rewards_max_spread: dec!(3.5),
                market_competitiveness: Some(dec!(1)),
            }],
            &markets,
            10,
            Some("mlb"),
            now,
        );
        assert!(skipped.is_empty());
    }

    #[test]
    fn snapshot_filter_keeps_started_live_markets_when_not_closed() {
        let reward = RewardProgram {
            condition_id: B256::ZERO,
            reward_daily_rate: dec!(2),
            rewards_min_size: dec!(50),
            rewards_max_spread: dec!(3.5),
            market_competitiveness: Some(dec!(1)),
        };
        let mut market = sample_market();
        market.event_start_time = Some(Utc.with_ymd_and_hms(2026, 4, 7, 9, 0, 0).unwrap());
        market.first_event = Some(EventSummary {
            start_time: Some(Utc.with_ymd_and_hms(2026, 4, 7, 9, 0, 0).unwrap()),
            live: Some(true),
            ended: Some(false),
            closed: Some(false),
        });

        let now = Utc.with_ymd_and_hms(2026, 4, 7, 10, 0, 0).unwrap();
        let mut markets = HashMap::new();
        markets.insert(B256::ZERO, market);

        let eligible = filter_snapshot_eligible(&[reward], &markets, None, now);
        assert_eq!(eligible.len(), 1);
    }

    #[test]
    fn reference_start_time_prefers_actual_start_signal() {
        let market = sample_market();
        assert_eq!(
            reference_start_time(&market),
            Some(Utc.with_ymd_and_hms(2026, 4, 7, 14, 0, 0).unwrap())
        );
    }
}
