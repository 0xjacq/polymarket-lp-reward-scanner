use chrono::{DateTime, Utc};
use clap::ValueEnum;
use polymarket_client_sdk::types::{Decimal, B256, U256};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct RewardProgram {
    pub condition_id: B256,
    pub reward_daily_rate: Decimal,
    pub rewards_min_size: Decimal,
    pub rewards_max_spread: Decimal,
    pub market_competitiveness: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct MarketTag {
    pub slug: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OutcomeToken {
    pub token_id: U256,
    pub outcome: String,
}

#[derive(Debug, Clone)]
pub struct EventSummary {
    pub start_time: Option<DateTime<Utc>>,
    pub live: Option<bool>,
    pub ended: Option<bool>,
    pub closed: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct MarketSnapshot {
    pub condition_id: B256,
    pub question: String,
    pub slug: Option<String>,
    pub image: Option<String>,
    pub tags: Vec<MarketTag>,
    pub tokens: Vec<OutcomeToken>,
    pub active: Option<bool>,
    pub accepting_orders: Option<bool>,
    pub enable_order_book: Option<bool>,
    pub closed: Option<bool>,
    pub archived: Option<bool>,
    pub start_date: Option<DateTime<Utc>>,
    pub end_date: Option<DateTime<Utc>>,
    pub game_start_time: Option<DateTime<Utc>>,
    pub event_start_time: Option<DateTime<Utc>>,
    pub first_event: Option<EventSummary>,
}

#[derive(Debug, Clone)]
pub struct BookLevel {
    pub price: Decimal,
    pub size: Decimal,
}

#[derive(Debug, Clone)]
pub struct BookSnapshot {
    pub token_id: U256,
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
    pub tick_size: Decimal,
}

#[derive(Debug, Clone)]
pub struct EligibleMarket {
    pub reward: RewardProgram,
    pub market: MarketSnapshot,
    pub event_start_time: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SortField {
    Apr,
    Time,
    Rate,
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingZone {
    Neutral,
    Extreme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpportunityStatus {
    CandidateNow,
    Watchlist,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpportunityReason {
    InBand,
    SpreadTooLarge,
    QueueTooThin,
    TooCrowded,
    ExtremeSingleSided,
    QuoteTooSmallForMinShares,
    MissingBookData,
    Unclear,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiquidityInfo {
    pub best_bid: Option<Decimal>,
    pub best_ask: Option<Decimal>,
    pub adjusted_midpoint: Option<Decimal>,
    pub tick_size: Decimal,
    pub reward_floor_price: Option<Decimal>,
    pub suggested_price: Option<Decimal>,
    pub queue_ahead_shares: Option<Decimal>,
    pub queue_ahead_notional: Option<Decimal>,
    pub queue_multiple: Option<Decimal>,
    pub qualifying_depth_shares: Option<Decimal>,
    pub distance_to_ask: Option<Decimal>,
    pub current_spread: Option<Decimal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Opportunity {
    pub market_id: String,
    pub question: String,
    pub side_to_trade: String,
    pub token_id: String,
    pub status: OpportunityStatus,
    pub reason: OpportunityReason,
    pub event_start_time: String,
    pub time_to_start_seconds: i64,
    pub time_to_start_human: String,
    pub reward_daily_rate: Decimal,
    pub pricing_zone: Option<PricingZone>,
    pub market_competitiveness: Option<Decimal>,
    pub spread_ratio: Option<Decimal>,
    pub apr_ceiling: Option<Decimal>,
    pub apr_estimated: Option<Decimal>,
    pub apr_effective: Option<Decimal>,
    pub suggested_price: Option<Decimal>,
    pub liquidity_info: LiquidityInfo,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardRow {
    pub market_id: String,
    pub question: String,
    pub event_start_time: Option<String>,
    pub reward_daily_rate: Decimal,
    pub rewards_max_spread: Decimal,
    pub rewards_min_size: Decimal,
    pub market_competitiveness: Option<Decimal>,
}
