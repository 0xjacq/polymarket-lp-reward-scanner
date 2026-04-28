use chrono::{DateTime, Utc};
use polymarket_client_sdk::types::{dec, Decimal, U256};

use crate::config;
use crate::models::{
    BookLevel, BookSnapshot, EligibleMarket, LiquidityInfo, Opportunity, OpportunityReason,
    OpportunityStatus, OutcomeToken, PricingZone, RewardProgram, SortField,
};

#[derive(Debug, Clone)]
struct TokenDecision {
    market_id: String,
    market_id_raw: polymarket_client_sdk::types::B256,
    question: String,
    side_to_trade: String,
    token_id: U256,
    token_id_str: String,
    status: OpportunityStatus,
    reason: OpportunityReason,
    event_start_time: DateTime<Utc>,
    reward_daily_rate: Decimal,
    rewards_max_spread: Decimal,
    rewards_min_size: Decimal,
    pricing_zone: Option<PricingZone>,
    market_competitiveness: Option<Decimal>,
    spread_ratio: Option<Decimal>,
    apr_ceiling: Option<Decimal>,
    apr_estimated: Option<Decimal>,
    apr_effective: Option<Decimal>,
    apr_lower: Option<Decimal>,
    apr_upper: Option<Decimal>,
    two_sided_apr: Option<Decimal>,
    suggested_price: Option<Decimal>,
    suggested_price_lower: Option<Decimal>,
    suggested_price_upper: Option<Decimal>,
    liquidity_info: LiquidityInfo,
}

pub fn market_competitiveness_p90(rewards: &[RewardProgram]) -> Option<Decimal> {
    let mut values: Vec<_> = rewards
        .iter()
        .filter_map(|reward| reward.market_competitiveness)
        .collect();
    if values.is_empty() {
        return None;
    }

    values.sort();
    let index = ((values.len() - 1) * 9) / 10;
    values.get(index).copied()
}

pub fn analyze_markets(
    eligible_markets: &[EligibleMarket],
    books: &std::collections::HashMap<U256, BookSnapshot>,
    quote_size_usdc: Decimal,
    min_queue_multiple: Decimal,
    two_sided: bool,
    competitiveness_p90: Option<Decimal>,
) -> Vec<Opportunity> {
    eligible_markets
        .iter()
        .filter_map(|market| {
            best_decision_for_market(
                market,
                books,
                quote_size_usdc,
                min_queue_multiple,
                two_sided,
                competitiveness_p90,
            )
        })
        .map(to_opportunity)
        .collect()
}

pub fn sort_opportunities(opportunities: &mut [Opportunity], sort_field: SortField) {
    opportunities.sort_by(|left, right| compare_opportunities(left, right, sort_field));
}

fn best_decision_for_market(
    eligible: &EligibleMarket,
    books: &std::collections::HashMap<U256, BookSnapshot>,
    quote_size_usdc: Decimal,
    min_queue_multiple: Decimal,
    two_sided: bool,
    competitiveness_p90: Option<Decimal>,
) -> Option<TokenDecision> {
    let mut decisions: Vec<_> = eligible
        .market
        .tokens
        .iter()
        .map(|token| {
            inspect_token(
                eligible,
                token,
                books.get(&token.token_id),
                quote_size_usdc,
                min_queue_multiple,
                two_sided,
                competitiveness_p90,
            )
        })
        .collect();

    decisions.sort_by(compare_token_decisions);
    decisions.into_iter().next()
}

fn inspect_token(
    eligible: &EligibleMarket,
    token: &OutcomeToken,
    book: Option<&BookSnapshot>,
    quote_size_usdc: Decimal,
    min_queue_multiple: Decimal,
    two_sided: bool,
    competitiveness_p90: Option<Decimal>,
) -> TokenDecision {
    let tick_size = book.map(|book| book.tick_size).unwrap_or(dec!(0.01));
    let market_competitiveness = eligible.reward.market_competitiveness;

    let mut decision = TokenDecision {
        market_id: eligible.reward.condition_id.to_string(),
        market_id_raw: eligible.reward.condition_id,
        question: eligible.market.question.clone(),
        side_to_trade: token.outcome.clone(),
        token_id: token.token_id,
        token_id_str: token.token_id.to_string(),
        status: OpportunityStatus::Skip,
        reason: OpportunityReason::MissingBookData,
        event_start_time: eligible.event_start_time,
        reward_daily_rate: eligible.reward.reward_daily_rate,
        rewards_max_spread: eligible.reward.rewards_max_spread,
        rewards_min_size: eligible.reward.rewards_min_size,
        pricing_zone: None,
        market_competitiveness,
        spread_ratio: None,
        apr_ceiling: None,
        apr_estimated: None,
        apr_effective: None,
        apr_lower: None,
        apr_upper: None,
        two_sided_apr: None,
        suggested_price: None,
        suggested_price_lower: None,
        suggested_price_upper: None,
        liquidity_info: LiquidityInfo {
            best_bid: None,
            best_ask: None,
            adjusted_midpoint: None,
            tick_size,
            reward_floor_price: None,
            suggested_price: None,
            queue_ahead_shares: None,
            queue_ahead_notional: None,
            queue_multiple: None,
            qualifying_depth_shares: None,
            distance_to_ask: None,
            current_spread: None,
        },
    };

    let Some(book) = book else {
        return decision;
    };

    let best_bid = book.bids.first().map(|level| level.price);
    let best_ask = book.asks.first().map(|level| level.price);
    let current_spread = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) => Some(ask - bid),
        _ => None,
    };
    let spread_band = eligible.reward.rewards_max_spread / dec!(100);
    let spread_ratio = current_spread.map(|spread| spread / spread_band);
    let adjusted_midpoint = adjusted_midpoint(book, eligible.reward.rewards_min_size);

    decision.liquidity_info.best_bid = best_bid;
    decision.liquidity_info.best_ask = best_ask;
    decision.liquidity_info.current_spread = current_spread;
    decision.spread_ratio = spread_ratio;
    decision.liquidity_info.adjusted_midpoint = adjusted_midpoint;

    let (Some(adjusted_midpoint), Some(best_ask)) = (adjusted_midpoint, best_ask) else {
        return decision;
    };

    let pricing_zone = if adjusted_midpoint >= dec!(0.10) && adjusted_midpoint <= dec!(0.90) {
        PricingZone::Neutral
    } else {
        PricingZone::Extreme
    };
    decision.pricing_zone = Some(pricing_zone);

    if pricing_zone == PricingZone::Extreme && !two_sided {
        decision.reason = OpportunityReason::ExtremeSingleSided;
        return decision;
    }

    let mut reward_floor_price = ceil_to_tick(adjusted_midpoint - spread_band, book.tick_size);
    if reward_floor_price < book.tick_size {
        reward_floor_price = book.tick_size;
    }
    decision.liquidity_info.reward_floor_price = Some(reward_floor_price);

    let suggested_price = suggested_bid_price(
        adjusted_midpoint,
        spread_band,
        reward_floor_price,
        book.tick_size,
        best_ask,
    );
    decision.suggested_price = suggested_price;
    decision.liquidity_info.suggested_price = suggested_price;

    let Some(suggested_price) = suggested_price else {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::Unclear;
        return decision;
    };

    let own_shares = quote_size_usdc / suggested_price;
    if own_shares < eligible.reward.rewards_min_size {
        decision.reason = OpportunityReason::QuoteTooSmallForMinShares;
        return decision;
    }

    let queue_ahead_shares = queue_ahead_shares(&book.bids, suggested_price);
    let queue_ahead_notional = queue_ahead_notional(&book.bids, suggested_price);
    let queue_multiple = queue_ahead_shares / own_shares;
    let qualifying_depth_shares =
        qualifying_depth_shares(&book.bids, reward_floor_price, adjusted_midpoint);
    let distance_to_ask = best_ask - suggested_price;

    decision.liquidity_info.queue_ahead_shares = Some(queue_ahead_shares);
    decision.liquidity_info.queue_ahead_notional = Some(queue_ahead_notional);
    decision.liquidity_info.queue_multiple = Some(queue_multiple);
    decision.liquidity_info.qualifying_depth_shares = Some(qualifying_depth_shares);
    decision.liquidity_info.distance_to_ask = Some(distance_to_ask);

    if decision
        .spread_ratio
        .map(|ratio| ratio > dec!(1))
        .unwrap_or(false)
    {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::SpreadTooLarge;
        return decision;
    }

    if queue_multiple < min_queue_multiple {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::QueueTooThin;
        return decision;
    }

    if competitiveness_p90
        .zip(market_competitiveness)
        .map(|(threshold, competitiveness)| competitiveness >= threshold)
        .unwrap_or(false)
    {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::TooCrowded;
        return decision;
    }

    let distance_from_midpoint = adjusted_midpoint - suggested_price;
    let Some(our_score) = score_weight(spread_band, distance_from_midpoint) else {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::Unclear;
        return decision;
    };

    let our_weight = our_score * own_shares;
    let visible_weight = visible_weight(
        &book.bids,
        adjusted_midpoint,
        spread_band,
        reward_floor_price,
    );
    let denominator = our_weight + visible_weight;
    if denominator <= dec!(0) {
        decision.status = OpportunityStatus::Watchlist;
        decision.reason = OpportunityReason::Unclear;
        return decision;
    }

    let apr_ceiling = eligible.reward.reward_daily_rate * dec!(36500) / quote_size_usdc;
    let apr_estimated =
        eligible.reward.reward_daily_rate * (our_weight / denominator) * dec!(36500)
            / quote_size_usdc;
    let apr_single = effective_apr(apr_estimated, pricing_zone, false);
    let apr_two = effective_apr(apr_estimated, pricing_zone, true);

    decision.status = OpportunityStatus::CandidateNow;
    decision.reason = OpportunityReason::InBand;
    decision.apr_ceiling = Some(apr_ceiling);
    decision.apr_estimated = Some(apr_estimated);
    decision.apr_effective = Some(apr_single);
    decision.two_sided_apr = Some(apr_two);

    decision.suggested_price_lower = price_at_band_fraction(
        reward_floor_price,
        spread_band,
        config::APR_LOWER_BAND_FRACTION,
        book.tick_size,
        best_ask,
    );
    decision.apr_lower = decision.suggested_price_lower.and_then(|price| {
        apr_at_price(
            eligible,
            &book.bids,
            quote_size_usdc,
            adjusted_midpoint,
            spread_band,
            reward_floor_price,
            pricing_zone,
            price,
        )
    });
    decision.suggested_price_upper = price_at_band_fraction(
        reward_floor_price,
        spread_band,
        config::APR_UPPER_BAND_FRACTION,
        book.tick_size,
        best_ask,
    );
    decision.apr_upper = decision.suggested_price_upper.and_then(|price| {
        apr_at_price(
            eligible,
            &book.bids,
            quote_size_usdc,
            adjusted_midpoint,
            spread_band,
            reward_floor_price,
            pricing_zone,
            price,
        )
    });

    decision
}

fn adjusted_midpoint(book: &BookSnapshot, rewards_min_size: Decimal) -> Option<Decimal> {
    let bid_price = price_at_cumulative_depth(&book.bids, rewards_min_size)
        .or_else(|| book.bids.first().map(|level| level.price))?;
    let ask_price = price_at_cumulative_depth(&book.asks, rewards_min_size)
        .or_else(|| book.asks.first().map(|level| level.price))?;

    Some((bid_price + ask_price) / dec!(2))
}

fn price_at_cumulative_depth(levels: &[BookLevel], threshold: Decimal) -> Option<Decimal> {
    let mut cumulative = dec!(0);
    for level in levels {
        cumulative += level.size;
        if cumulative >= threshold {
            return Some(level.price);
        }
    }
    None
}

fn queue_ahead_shares(levels: &[BookLevel], suggested_price: Decimal) -> Decimal {
    levels
        .iter()
        .filter(|level| level.price >= suggested_price)
        .fold(dec!(0), |acc, level| acc + level.size)
}

fn queue_ahead_notional(levels: &[BookLevel], suggested_price: Decimal) -> Decimal {
    levels
        .iter()
        .filter(|level| level.price >= suggested_price)
        .fold(dec!(0), |acc, level| acc + (level.size * level.price))
}

fn qualifying_depth_shares(
    levels: &[BookLevel],
    reward_floor: Decimal,
    midpoint: Decimal,
) -> Decimal {
    levels
        .iter()
        .filter(|level| level.price >= reward_floor && level.price < midpoint)
        .fold(dec!(0), |acc, level| acc + level.size)
}

fn visible_weight(
    levels: &[BookLevel],
    midpoint: Decimal,
    spread_band: Decimal,
    reward_floor: Decimal,
) -> Decimal {
    levels
        .iter()
        .filter(|level| level.price >= reward_floor && level.price < midpoint)
        .filter_map(|level| {
            let distance = midpoint - level.price;
            score_weight(spread_band, distance).map(|weight| weight * level.size)
        })
        .fold(dec!(0), |acc, value| acc + value)
}

fn score_weight(spread_band: Decimal, distance: Decimal) -> Option<Decimal> {
    if spread_band <= dec!(0) || distance < dec!(0) || distance > spread_band {
        return None;
    }

    let ratio = (spread_band - distance) / spread_band;
    Some(ratio * ratio)
}

fn suggested_bid_price(
    midpoint: Decimal,
    spread_band: Decimal,
    reward_floor_price: Decimal,
    tick_size: Decimal,
    best_ask: Decimal,
) -> Option<Decimal> {
    let mut candidate = reward_floor_price;

    // On a discrete tick grid, ceil(midpoint - band) can land exactly on the reward boundary.
    // That quote has zero score weight, so we nudge it one tick toward the midpoint when possible.
    if tick_size > dec!(0) && score_weight(spread_band, midpoint - candidate) == Some(dec!(0)) {
        candidate += tick_size;
    }

    let score = score_weight(spread_band, midpoint - candidate)?;
    if score <= dec!(0) || candidate >= best_ask {
        return None;
    }

    Some(candidate)
}

fn ceil_to_tick(value: Decimal, tick_size: Decimal) -> Decimal {
    if tick_size <= dec!(0) {
        return value;
    }

    (value / tick_size).ceil() * tick_size
}

fn effective_apr(apr_estimated: Decimal, pricing_zone: PricingZone, two_sided: bool) -> Decimal {
    if two_sided {
        return apr_estimated;
    }

    match pricing_zone {
        PricingZone::Extreme => dec!(0),
        PricingZone::Neutral => apr_estimated / Decimal::from(config::SINGLE_SIDED_PENALTY),
    }
}

fn price_at_band_fraction(
    reward_floor_price: Decimal,
    spread_band: Decimal,
    fraction: f64,
    tick_size: Decimal,
    best_ask: Decimal,
) -> Option<Decimal> {
    let fraction_decimal = fraction.to_string().parse::<Decimal>().ok()?;
    let distance = spread_band * fraction_decimal;
    let price = ceil_to_tick(reward_floor_price + distance, tick_size);
    if price >= best_ask {
        return None;
    }
    Some(price)
}

fn apr_at_price(
    eligible: &EligibleMarket,
    bids: &[BookLevel],
    quote_size_usdc: Decimal,
    midpoint: Decimal,
    spread_band: Decimal,
    reward_floor: Decimal,
    pricing_zone: PricingZone,
    quote_price: Decimal,
) -> Option<Decimal> {
    let own_shares = quote_size_usdc / quote_price;
    if own_shares < eligible.reward.rewards_min_size {
        return None;
    }

    let distance = midpoint - quote_price;
    let our_score = score_weight(spread_band, distance)?;
    let our_weight = our_score * own_shares;

    let visible_weight = visible_weight(bids, midpoint, spread_band, reward_floor);
    let denominator = our_weight + visible_weight;
    if denominator <= dec!(0) {
        return None;
    }

    let raw = eligible.reward.reward_daily_rate * (our_weight / denominator) * dec!(36500)
        / quote_size_usdc;
    let effective = effective_apr(raw, pricing_zone, false);
    Some(effective)
}

fn compare_token_decisions(left: &TokenDecision, right: &TokenDecision) -> std::cmp::Ordering {
    status_bucket(left.status)
        .cmp(&status_bucket(right.status))
        .then_with(|| match (left.status, right.status) {
            (OpportunityStatus::CandidateNow, OpportunityStatus::CandidateNow) => {
                compare_candidate_decisions(left, right)
            }
            (OpportunityStatus::Watchlist, OpportunityStatus::Watchlist) => {
                compare_watchlist_decisions(left, right)
            }
            (OpportunityStatus::Skip, OpportunityStatus::Skip) => {
                compare_skip_decisions(left, right)
            }
            _ => std::cmp::Ordering::Equal,
        })
}

fn compare_candidate_decisions(left: &TokenDecision, right: &TokenDecision) -> std::cmp::Ordering {
    right
        .liquidity_info
        .queue_multiple
        .cmp(&left.liquidity_info.queue_multiple)
        .then_with(|| {
            right
                .liquidity_info
                .distance_to_ask
                .cmp(&left.liquidity_info.distance_to_ask)
        })
        .then_with(|| {
            right
                .liquidity_info
                .qualifying_depth_shares
                .cmp(&left.liquidity_info.qualifying_depth_shares)
        })
        .then_with(|| right.apr_effective.cmp(&left.apr_effective))
        .then_with(|| right.apr_estimated.cmp(&left.apr_estimated))
        .then_with(|| left.suggested_price.cmp(&right.suggested_price))
        .then_with(|| left.market_id_raw.cmp(&right.market_id_raw))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn compare_watchlist_decisions(left: &TokenDecision, right: &TokenDecision) -> std::cmp::Ordering {
    compare_option_decimal_asc(left.spread_ratio, right.spread_ratio)
        .then_with(|| {
            compare_option_decimal_desc(
                left.liquidity_info.qualifying_depth_shares,
                right.liquidity_info.qualifying_depth_shares,
            )
        })
        .then_with(|| {
            compare_option_decimal_asc(left.market_competitiveness, right.market_competitiveness)
        })
        .then_with(|| left.market_id_raw.cmp(&right.market_id_raw))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn compare_skip_decisions(left: &TokenDecision, right: &TokenDecision) -> std::cmp::Ordering {
    diagnostic_completeness(right)
        .cmp(&diagnostic_completeness(left))
        .then_with(|| compare_option_decimal_asc(left.spread_ratio, right.spread_ratio))
        .then_with(|| left.market_id_raw.cmp(&right.market_id_raw))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn compare_opportunities(
    left: &Opportunity,
    right: &Opportunity,
    sort_field: SortField,
) -> std::cmp::Ordering {
    status_bucket(left.status)
        .cmp(&status_bucket(right.status))
        .then_with(|| match (left.status, right.status) {
            (OpportunityStatus::CandidateNow, OpportunityStatus::CandidateNow) => {
                compare_candidate_opportunities(left, right, sort_field)
            }
            (OpportunityStatus::Watchlist, OpportunityStatus::Watchlist) => {
                compare_watchlist_opportunities(left, right, sort_field)
            }
            (OpportunityStatus::Skip, OpportunityStatus::Skip) => {
                compare_skip_opportunities(left, right, sort_field)
            }
            _ => std::cmp::Ordering::Equal,
        })
}

fn compare_candidate_opportunities(
    left: &Opportunity,
    right: &Opportunity,
    sort_field: SortField,
) -> std::cmp::Ordering {
    let primary = match sort_field {
        SortField::Apr => compare_option_decimal_desc(left.apr_effective, right.apr_effective),
        SortField::Time => left.time_to_start_seconds.cmp(&right.time_to_start_seconds),
        SortField::Rate => right.reward_daily_rate.cmp(&left.reward_daily_rate),
        SortField::Queue => compare_option_decimal_desc(
            left.liquidity_info.queue_multiple,
            right.liquidity_info.queue_multiple,
        ),
    };

    primary
        .then_with(|| compare_option_decimal_desc(left.apr_effective, right.apr_effective))
        .then_with(|| compare_option_decimal_desc(left.apr_estimated, right.apr_estimated))
        .then_with(|| left.market_id.cmp(&right.market_id))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn compare_watchlist_opportunities(
    left: &Opportunity,
    right: &Opportunity,
    sort_field: SortField,
) -> std::cmp::Ordering {
    let primary = match sort_field {
        SortField::Apr => right
            .reward_daily_rate
            .cmp(&left.reward_daily_rate)
            .then_with(|| compare_option_decimal_asc(left.spread_ratio, right.spread_ratio))
            .then_with(|| {
                compare_option_decimal_asc(
                    left.market_competitiveness,
                    right.market_competitiveness,
                )
            }),
        SortField::Time => left.time_to_start_seconds.cmp(&right.time_to_start_seconds),
        SortField::Rate => right.reward_daily_rate.cmp(&left.reward_daily_rate),
        SortField::Queue => compare_option_decimal_desc(
            left.liquidity_info.queue_multiple,
            right.liquidity_info.queue_multiple,
        ),
    };

    primary
        .then_with(|| left.market_id.cmp(&right.market_id))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn compare_skip_opportunities(
    left: &Opportunity,
    right: &Opportunity,
    sort_field: SortField,
) -> std::cmp::Ordering {
    let primary = match sort_field {
        SortField::Apr | SortField::Rate => right.reward_daily_rate.cmp(&left.reward_daily_rate),
        SortField::Time => left.time_to_start_seconds.cmp(&right.time_to_start_seconds),
        SortField::Queue => compare_option_decimal_desc(
            left.liquidity_info.queue_multiple,
            right.liquidity_info.queue_multiple,
        ),
    };

    primary
        .then_with(|| {
            diagnostic_completeness_from_opportunity(right)
                .cmp(&diagnostic_completeness_from_opportunity(left))
        })
        .then_with(|| compare_option_decimal_asc(left.spread_ratio, right.spread_ratio))
        .then_with(|| left.market_id.cmp(&right.market_id))
        .then_with(|| left.token_id.cmp(&right.token_id))
}

fn status_bucket(status: OpportunityStatus) -> u8 {
    match status {
        OpportunityStatus::CandidateNow => 0,
        OpportunityStatus::Watchlist => 1,
        OpportunityStatus::Skip => 2,
    }
}

fn compare_option_decimal_asc(left: Option<Decimal>, right: Option<Decimal>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn compare_option_decimal_desc(
    left: Option<Decimal>,
    right: Option<Decimal>,
) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn diagnostic_completeness(candidate: &TokenDecision) -> usize {
    [
        candidate.liquidity_info.adjusted_midpoint.is_some(),
        candidate.liquidity_info.current_spread.is_some(),
        candidate.suggested_price.is_some(),
        candidate.liquidity_info.queue_multiple.is_some(),
        candidate.spread_ratio.is_some(),
        candidate.market_competitiveness.is_some(),
    ]
    .into_iter()
    .filter(|flag| *flag)
    .count()
}

fn diagnostic_completeness_from_opportunity(opportunity: &Opportunity) -> usize {
    [
        opportunity.liquidity_info.adjusted_midpoint.is_some(),
        opportunity.liquidity_info.current_spread.is_some(),
        opportunity.suggested_price.is_some(),
        opportunity.liquidity_info.queue_multiple.is_some(),
        opportunity.spread_ratio.is_some(),
        opportunity.market_competitiveness.is_some(),
    ]
    .into_iter()
    .filter(|flag| *flag)
    .count()
}

fn to_opportunity(candidate: TokenDecision) -> Opportunity {
    let time_to_start_seconds = (candidate.event_start_time - Utc::now()).num_seconds();

    Opportunity {
        market_id: candidate.market_id,
        question: candidate.question,
        side_to_trade: candidate.side_to_trade,
        token_id: candidate.token_id_str,
        status: candidate.status,
        reason: candidate.reason,
        event_start_time: candidate.event_start_time.to_rfc3339(),
        time_to_start_seconds,
        time_to_start_human: human_duration(time_to_start_seconds),
        reward_daily_rate: candidate.reward_daily_rate,
        rewards_max_spread: candidate.rewards_max_spread,
        rewards_min_size: candidate.rewards_min_size,
        pricing_zone: candidate.pricing_zone,
        market_competitiveness: candidate.market_competitiveness,
        spread_ratio: candidate.spread_ratio,
        apr_ceiling: candidate.apr_ceiling,
        apr_estimated: candidate.apr_estimated,
        apr_effective: candidate.apr_effective,
        apr_lower: candidate.apr_lower,
        apr_upper: candidate.apr_upper,
        two_sided_apr: candidate.two_sided_apr,
        suggested_price: candidate.suggested_price,
        suggested_price_lower: candidate.suggested_price_lower,
        suggested_price_upper: candidate.suggested_price_upper,
        liquidity_info: candidate.liquidity_info,
    }
}

pub fn human_duration(seconds: i64) -> String {
    if seconds <= 0 {
        return "started".to_string();
    }

    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;

    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use polymarket_client_sdk::types::{dec, B256, U256};

    use super::{
        adjusted_midpoint, ceil_to_tick, effective_apr, human_duration, inspect_token,
        market_competitiveness_p90, suggested_bid_price,
    };
    use crate::models::{
        BookLevel, BookSnapshot, EligibleMarket, EventSummary, MarketSnapshot, OpportunityReason,
        OpportunityStatus, OutcomeToken, PricingZone, RewardProgram,
    };

    fn sample_market() -> EligibleMarket {
        EligibleMarket {
            reward: RewardProgram {
                condition_id: B256::ZERO,
                reward_daily_rate: dec!(5),
                rewards_min_size: dec!(50),
                rewards_max_spread: dec!(3.5),
                market_competitiveness: Some(dec!(1)),
            },
            market: MarketSnapshot {
                condition_id: B256::ZERO,
                question: "Question".to_string(),
                image: None,
                market_slug: Some("question-market".to_string()),
                event_slug: Some("question-event".to_string()),
                tags: Vec::new(),
                tokens: vec![
                    OutcomeToken {
                        token_id: U256::from(1u64),
                        outcome: "YES".to_string(),
                    },
                    OutcomeToken {
                        token_id: U256::from(2u64),
                        outcome: "NO".to_string(),
                    },
                ],
                active: Some(true),
                accepting_orders: Some(true),
                enable_order_book: Some(true),
                closed: Some(false),
                archived: Some(false),
                start_date: Some(Utc.with_ymd_and_hms(2026, 4, 7, 12, 0, 0).unwrap()),
                end_date: Some(Utc.with_ymd_and_hms(2026, 4, 8, 12, 0, 0).unwrap()),
                game_start_time: None,
                event_start_time: Some(Utc.with_ymd_and_hms(2026, 4, 7, 15, 0, 0).unwrap()),
                first_event: Some(EventSummary {
                    start_time: None,
                    live: Some(false),
                    ended: Some(false),
                    closed: Some(false),
                }),
            },
            event_start_time: Utc.with_ymd_and_hms(2026, 4, 7, 15, 0, 0).unwrap(),
        }
    }

    fn sample_book() -> BookSnapshot {
        BookSnapshot {
            token_id: U256::from(1u64),
            bids: vec![
                BookLevel {
                    price: dec!(0.50),
                    size: dec!(20),
                },
                BookLevel {
                    price: dec!(0.49),
                    size: dec!(40),
                },
                BookLevel {
                    price: dec!(0.48),
                    size: dec!(100),
                },
            ],
            asks: vec![
                BookLevel {
                    price: dec!(0.52),
                    size: dec!(20),
                },
                BookLevel {
                    price: dec!(0.53),
                    size: dec!(60),
                },
            ],
            tick_size: dec!(0.01),
        }
    }

    #[test]
    fn midpoint_uses_cumulative_depth() {
        let midpoint = adjusted_midpoint(&sample_book(), dec!(50)).unwrap();
        assert_eq!(midpoint, dec!(0.51));
    }

    #[test]
    fn candidate_price_rounds_up_to_tick() {
        assert_eq!(ceil_to_tick(dec!(0.465), dec!(0.01)), dec!(0.47));
    }

    #[test]
    fn suggested_price_stays_on_rounded_floor_when_already_inside_band() {
        let suggested =
            suggested_bid_price(dec!(0.51), dec!(0.035), dec!(0.48), dec!(0.01), dec!(0.52));
        assert_eq!(suggested, Some(dec!(0.48)));
    }

    #[test]
    fn suggested_price_moves_one_tick_inside_when_floor_has_zero_weight() {
        let suggested =
            suggested_bid_price(dec!(0.50), dec!(0.04), dec!(0.46), dec!(0.01), dec!(0.51));
        assert_eq!(suggested, Some(dec!(0.47)));
    }

    #[test]
    fn market_competitiveness_threshold_uses_top_decile() {
        let rewards = vec![
            RewardProgram {
                condition_id: B256::ZERO,
                reward_daily_rate: dec!(1),
                rewards_min_size: dec!(10),
                rewards_max_spread: dec!(3),
                market_competitiveness: Some(dec!(1)),
            },
            RewardProgram {
                condition_id: B256::from([1u8; 32]),
                reward_daily_rate: dec!(1),
                rewards_min_size: dec!(10),
                rewards_max_spread: dec!(3),
                market_competitiveness: Some(dec!(2)),
            },
            RewardProgram {
                condition_id: B256::from([2u8; 32]),
                reward_daily_rate: dec!(1),
                rewards_min_size: dec!(10),
                rewards_max_spread: dec!(3),
                market_competitiveness: Some(dec!(100)),
            },
        ];

        assert_eq!(market_competitiveness_p90(&rewards), Some(dec!(2)));
    }

    #[test]
    fn scoring_skips_extreme_single_sided() {
        let mut book = sample_book();
        book.bids[0].price = dec!(0.03);
        book.bids[1].price = dec!(0.02);
        book.bids[2].price = dec!(0.01);
        book.asks[0].price = dec!(0.05);
        book.asks[1].price = dec!(0.06);

        let scored = inspect_token(
            &sample_market(),
            &sample_market().market.tokens[0],
            Some(&book),
            dec!(100),
            dec!(2),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::Skip);
        assert_eq!(scored.reason, OpportunityReason::ExtremeSingleSided);
    }

    #[test]
    fn scoring_creates_watchlist_for_large_spread() {
        let mut book = sample_book();
        book.asks[0].price = dec!(0.60);
        book.asks[1].price = dec!(0.61);

        let scored = inspect_token(
            &sample_market(),
            &sample_market().market.tokens[0],
            Some(&book),
            dec!(100),
            dec!(2),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::Watchlist);
        assert_eq!(scored.reason, OpportunityReason::SpreadTooLarge);
    }

    #[test]
    fn scoring_creates_watchlist_for_thin_queue() {
        let scored = inspect_token(
            &sample_market(),
            &sample_market().market.tokens[0],
            Some(&sample_book()),
            dec!(50),
            dec!(100),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::Watchlist);
        assert_eq!(scored.reason, OpportunityReason::QueueTooThin);
    }

    #[test]
    fn scoring_creates_watchlist_for_crowded_market() {
        let mut market = sample_market();
        market.reward.market_competitiveness = Some(dec!(50));

        let scored = inspect_token(
            &market,
            &market.market.tokens[0],
            Some(&sample_book()),
            dec!(50),
            dec!(1),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::Watchlist);
        assert_eq!(scored.reason, OpportunityReason::TooCrowded);
    }

    #[test]
    fn scoring_skips_when_quote_is_too_small() {
        let scored = inspect_token(
            &sample_market(),
            &sample_market().market.tokens[0],
            Some(&sample_book()),
            dec!(1),
            dec!(1),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::Skip);
        assert_eq!(scored.reason, OpportunityReason::QuoteTooSmallForMinShares);
    }

    #[test]
    fn scoring_computes_candidate_and_apr() {
        let scored = inspect_token(
            &sample_market(),
            &sample_market().market.tokens[0],
            Some(&sample_book()),
            dec!(50),
            dec!(1),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::CandidateNow);
        assert_eq!(scored.reason, OpportunityReason::InBand);
        assert!(scored.apr_estimated.unwrap() > dec!(0));
        assert_eq!(
            scored.apr_effective.unwrap(),
            scored.apr_estimated.unwrap() / dec!(3)
        );
        assert_eq!(scored.two_sided_apr.unwrap(), scored.apr_estimated.unwrap());
        assert_eq!(scored.suggested_price, Some(dec!(0.48)));
    }

    #[test]
    fn scoring_bumps_boundary_quote_by_one_tick_before_apr() {
        let mut market = sample_market();
        market.reward.rewards_max_spread = dec!(4);

        let book = BookSnapshot {
            token_id: U256::from(1u64),
            bids: vec![
                BookLevel {
                    price: dec!(0.49),
                    size: dec!(200),
                },
                BookLevel {
                    price: dec!(0.48),
                    size: dec!(200),
                },
                BookLevel {
                    price: dec!(0.47),
                    size: dec!(200),
                },
            ],
            asks: vec![
                BookLevel {
                    price: dec!(0.51),
                    size: dec!(200),
                },
                BookLevel {
                    price: dec!(0.52),
                    size: dec!(200),
                },
            ],
            tick_size: dec!(0.01),
        };

        let scored = inspect_token(
            &market,
            &market.market.tokens[0],
            Some(&book),
            dec!(100),
            dec!(1),
            false,
            Some(dec!(10)),
        );

        assert_eq!(scored.status, OpportunityStatus::CandidateNow);
        assert_eq!(scored.reason, OpportunityReason::InBand);
        assert_eq!(scored.liquidity_info.reward_floor_price, Some(dec!(0.46)));
        assert_eq!(scored.suggested_price, Some(dec!(0.47)));
        assert!(scored.apr_estimated.unwrap() > dec!(0));
    }

    #[test]
    fn human_duration_formats() {
        assert_eq!(human_duration(5400), "1h 30m");
    }

    #[test]
    fn effective_apr_single_sided_neutral_is_discounted() {
        assert_eq!(
            effective_apr(dec!(150), PricingZone::Neutral, false),
            dec!(50)
        );
    }

    #[test]
    fn effective_apr_single_sided_extreme_is_zero() {
        assert_eq!(
            effective_apr(dec!(150), PricingZone::Extreme, false),
            dec!(0)
        );
    }

    #[test]
    fn effective_apr_two_sided_keeps_raw_apr() {
        assert_eq!(
            effective_apr(dec!(150), PricingZone::Neutral, true),
            dec!(150)
        );
        assert_eq!(
            effective_apr(dec!(150), PricingZone::Extreme, true),
            dec!(150)
        );
    }
}
