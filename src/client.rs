use std::collections::{HashMap, HashSet};
use std::future::Future;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures::{stream, StreamExt};
use polymarket_client_sdk::clob::{
    types::request::OrderBookSummaryRequest,
    types::response::{CurrentRewardResponse, OrderBookSummaryResponse, Page},
    Client as ClobClient, Config as ClobConfig,
};
use polymarket_client_sdk::error::{Error as SdkError, Kind as ErrorKind, Status, StatusCode};
use polymarket_client_sdk::gamma::{
    types::request::MarketsRequest,
    types::response::{Event, Market},
    Client as GammaClient,
};
use polymarket_client_sdk::types::{dec, Decimal, B256, U256};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use tokio::time::{sleep, timeout};

use crate::config;
use crate::models::{
    BookLevel, BookSnapshot, EventSummary, MarketSnapshot, MarketTag, OutcomeToken, RewardProgram,
};

pub struct PolymarketClient {
    clob: ClobClient,
    gamma: GammaClient,
    http: HttpClient,
}

#[derive(Debug, Clone, Deserialize)]
struct RewardDetailResponse {
    condition_id: Option<B256>,
    question: Option<String>,
    market_slug: Option<String>,
    rewards_max_spread: Option<Decimal>,
    rewards_min_size: Option<Decimal>,
    market_competitiveness: Option<Decimal>,
}

#[derive(Debug, Clone)]
pub struct RewardDetailSnapshot {
    pub condition_id: B256,
    pub question: Option<String>,
    pub market_slug: Option<String>,
    pub rewards_max_spread: Option<Decimal>,
    pub rewards_min_size: Option<Decimal>,
    pub market_competitiveness: Option<Decimal>,
}

impl PolymarketClient {
    pub fn new() -> Result<Self> {
        let clob = ClobClient::new(config::CLOB_HOST, ClobConfig::default())
            .context("failed to create CLOB client")?;
        let gamma =
            GammaClient::new(config::GAMMA_HOST).context("failed to create Gamma client")?;
        let http = HttpClient::builder()
            .connect_timeout(config::operation_timeout())
            .timeout(config::operation_timeout())
            .build()
            .context("failed to create HTTP client")?;

        Ok(Self { clob, gamma, http })
    }

    pub async fn fetch_current_rewards_all(&self) -> Result<Vec<RewardProgram>> {
        let mut cursor = None;
        let mut rewards = Vec::new();

        loop {
            let page = self.fetch_current_rewards_page(cursor.clone()).await?;

            rewards.extend(page.data.into_iter().map(normalize_reward));

            if page.next_cursor == config::CURSOR_DONE {
                break;
            }

            cursor = Some(page.next_cursor);
        }

        Ok(rewards)
    }

    pub async fn fetch_market_competitiveness(
        &self,
        condition_ids: &[B256],
    ) -> HashMap<B256, Option<Decimal>> {
        let detail_results = stream::iter(condition_ids.iter().copied())
            .map(|condition_id| async move {
                let result = self.fetch_market_competitiveness_detail(condition_id).await;
                (condition_id, result)
            })
            .buffer_unordered(config::REWARD_DETAIL_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;

        let mut competitiveness = HashMap::new();
        for (condition_id, result) in detail_results {
            match result {
                Ok(value) => {
                    competitiveness.insert(condition_id, value);
                }
                Err(err) => {
                    eprintln!("warning: reward detail fetch failed for {condition_id}: {err}");
                    competitiveness.insert(condition_id, None);
                }
            }
        }

        competitiveness
    }

    pub async fn fetch_reward_details(
        &self,
        condition_ids: &[B256],
    ) -> HashMap<B256, RewardDetailSnapshot> {
        let detail_results = stream::iter(condition_ids.iter().copied())
            .map(|condition_id| async move {
                let result = self.fetch_reward_detail(condition_id).await;
                (condition_id, result)
            })
            .buffer_unordered(config::REWARD_DETAIL_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;

        let mut details = HashMap::new();
        for (condition_id, result) in detail_results {
            match result {
                Ok(Some(detail)) => {
                    details.insert(condition_id, detail);
                }
                Ok(None) => {}
                Err(err) => {
                    eprintln!("warning: reward detail fetch failed for {condition_id}: {err}");
                }
            }
        }

        details
    }

    pub async fn fetch_markets_by_condition_ids(
        &self,
        condition_ids: &[B256],
    ) -> Result<HashMap<B256, MarketSnapshot>> {
        if condition_ids.len() >= config::GAMMA_PAGINATION_DIRECT_THRESHOLD {
            eprintln!(
                "warning: large rewards universe ({} ids), using direct paginated gamma scan",
                condition_ids.len()
            );
            let requested: HashSet<_> = condition_ids.iter().copied().collect();
            return self.fetch_markets_by_pagination(&requested).await;
        }

        let mut found = HashMap::new();

        let chunked_ids: Vec<Vec<B256>> = condition_ids
            .chunks(config::GAMMA_BATCH_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect();

        let batch_results = stream::iter(chunked_ids.into_iter().map(|chunk| async move {
            let request = MarketsRequest::builder()
                .condition_ids(chunk.clone())
                .include_tag(true)
                .build();

            let result = self
                .call_with_retry("gamma_markets_batch", || self.gamma.markets(&request))
                .await;

            (chunk, result)
        }))
        .buffer_unordered(config::GAMMA_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        let mut missing_ids = Vec::new();
        for (requested_chunk, result) in batch_results {
            match result {
                Ok(markets) => {
                    let mut batch_found = HashSet::new();
                    for market in markets {
                        if let Some(snapshot) = normalize_market(market) {
                            batch_found.insert(snapshot.condition_id);
                            found.insert(snapshot.condition_id, snapshot);
                        }
                    }

                    missing_ids.extend(
                        requested_chunk
                            .into_iter()
                            .filter(|condition_id| !batch_found.contains(condition_id)),
                    );
                }
                Err(err) => {
                    eprintln!(
                        "warning: gamma batch fetch failed for {} ids: {err}",
                        requested_chunk.len()
                    );
                    missing_ids.extend(requested_chunk);
                }
            }
        }

        if missing_ids.len() >= config::GAMMA_PAGINATION_FALLBACK_THRESHOLD {
            eprintln!(
                "warning: gamma batch join missed {} condition ids, falling back to paginated markets scan",
                missing_ids.len()
            );
            let requested: HashSet<_> = condition_ids.iter().copied().collect();
            return self.fetch_markets_by_pagination(&requested).await;
        }

        let single_results = stream::iter(missing_ids.into_iter().map(|condition_id| async move {
            let request = MarketsRequest::builder()
                .condition_ids(vec![condition_id])
                .include_tag(true)
                .build();

            let result = self
                .call_with_retry("gamma_markets_single", || self.gamma.markets(&request))
                .await;

            (condition_id, result)
        }))
        .buffer_unordered(config::GAMMA_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        for (condition_id, result) in single_results {
            match result {
                Ok(markets) => {
                    for market in markets {
                        if let Some(snapshot) = normalize_market(market) {
                            found.insert(snapshot.condition_id, snapshot);
                        }
                    }
                }
                Err(err) => {
                    eprintln!("warning: gamma fetch failed for {condition_id}: {err}");
                }
            }
        }

        Ok(found)
    }

    async fn fetch_markets_by_pagination(
        &self,
        requested: &HashSet<B256>,
    ) -> Result<HashMap<B256, MarketSnapshot>> {
        let mut found = HashMap::new();
        let mut offset = 0i32;

        loop {
            let request = MarketsRequest::builder()
                .limit(config::GAMMA_PAGE_SIZE)
                .offset(offset)
                .closed(false)
                .include_tag(true)
                .build();

            let markets = self
                .call_with_retry("gamma_markets_paginated", || self.gamma.markets(&request))
                .await?;

            let page_len = markets.len();
            for market in markets {
                if let Some(snapshot) = normalize_market(market) {
                    if requested.contains(&snapshot.condition_id) {
                        found.insert(snapshot.condition_id, snapshot);
                    }
                }
            }

            if found.len() >= requested.len() || page_len < config::GAMMA_PAGE_SIZE as usize {
                break;
            }

            offset += config::GAMMA_PAGE_SIZE;
        }

        Ok(found)
    }

    pub async fn fetch_order_books(
        &self,
        token_ids: &[U256],
    ) -> Result<HashMap<U256, BookSnapshot>> {
        let mut books = HashMap::new();
        let chunks: Vec<Vec<U256>> = token_ids
            .chunks(config::INITIAL_BOOK_BATCH_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect();

        let fetched_chunks = stream::iter(
            chunks
                .into_iter()
                .map(|chunk| async move { self.fetch_order_books_chunk(&chunk).await }),
        )
        .buffer_unordered(config::BOOK_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        for fetched in fetched_chunks {
            for book in fetched {
                books.insert(book.token_id, book);
            }
        }

        Ok(books)
    }

    async fn fetch_order_books_chunk(&self, token_ids: &[U256]) -> Vec<BookSnapshot> {
        if token_ids.is_empty() {
            return Vec::new();
        }

        let requests: Vec<_> = token_ids
            .iter()
            .map(|token_id| {
                OrderBookSummaryRequest::builder()
                    .token_id(*token_id)
                    .build()
            })
            .collect();

        match self
            .call_with_retry("order_books", || self.clob.order_books(&requests))
            .await
        {
            Ok(response) => response.into_iter().map(normalize_book).collect(),
            Err(_err) if token_ids.len() > 1 => {
                let mid = token_ids.len() / 2;
                let mut left = Box::pin(self.fetch_order_books_chunk(&token_ids[..mid])).await;
                let mut right = Box::pin(self.fetch_order_books_chunk(&token_ids[mid..])).await;
                left.append(&mut right);
                left
            }
            Err(err) => {
                eprintln!(
                    "warning: order book fetch failed for {}: {err}",
                    token_ids[0]
                );
                Vec::new()
            }
        }
    }

    async fn call_with_retry<T, F, Fut>(&self, label: &str, mut f: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = polymarket_client_sdk::Result<T>>,
    {
        let mut last_error = None;

        for attempt in 0..config::MAX_RETRIES {
            match timeout(config::operation_timeout(), f()).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(err)) => {
                    let retryable = is_retryable(&err);
                    last_error = Some(anyhow::Error::new(err));

                    if !retryable || attempt + 1 == config::MAX_RETRIES {
                        break;
                    }
                }
                Err(err) => {
                    last_error = Some(anyhow::Error::new(err));
                }
            }

            sleep(config::retry_delay(attempt)).await;
            eprintln!("warning: retrying {label} attempt {}", attempt + 2);
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("operation failed: {label}")))
    }

    async fn fetch_current_rewards_page(
        &self,
        cursor: Option<String>,
    ) -> Result<Page<CurrentRewardResponse>> {
        let mut last_error = None;

        for attempt in 0..config::MAX_RETRIES {
            let request = || async {
                let mut http_request = self
                    .http
                    .get(format!("{}/rewards/markets/current", config::CLOB_HOST));

                if let Some(cursor) = cursor.as_ref() {
                    http_request = http_request.query(&[("next_cursor", cursor)]);
                }

                let response = http_request.send().await?;
                let response = response.error_for_status()?;
                response.json::<Page<CurrentRewardResponse>>().await
            };

            match timeout(config::operation_timeout(), request()).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(err)) => {
                    let retryable = is_retryable_http(&err);
                    last_error = Some(anyhow::Error::new(err));

                    if !retryable || attempt + 1 == config::MAX_RETRIES {
                        break;
                    }
                }
                Err(err) => {
                    last_error = Some(anyhow::Error::new(err));
                }
            }

            sleep(config::retry_delay(attempt)).await;
            eprintln!("warning: retrying current_rewards attempt {}", attempt + 2);
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("operation failed: current_rewards")))
    }

    async fn fetch_market_competitiveness_detail(
        &self,
        condition_id: B256,
    ) -> Result<Option<Decimal>> {
        let mut last_error = None;

        for attempt in 0..config::MAX_RETRIES {
            let request = || async {
                let response = self
                    .http
                    .get(format!(
                        "{}/rewards/markets/{}",
                        config::CLOB_HOST,
                        condition_id
                    ))
                    .send()
                    .await?;
                let response = response.error_for_status()?;
                let page = response.json::<Page<RewardDetailResponse>>().await?;
                Ok::<_, reqwest::Error>(
                    page.data
                        .into_iter()
                        .next()
                        .and_then(|detail| detail.market_competitiveness),
                )
            };

            match timeout(config::operation_timeout(), request()).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(err)) => {
                    let retryable = is_retryable_http(&err);
                    last_error = Some(anyhow::Error::new(err));

                    if !retryable || attempt + 1 == config::MAX_RETRIES {
                        break;
                    }
                }
                Err(err) => {
                    last_error = Some(anyhow::Error::new(err));
                }
            }

            sleep(config::retry_delay(attempt)).await;
            eprintln!(
                "warning: retrying reward detail fetch for {condition_id} attempt {}",
                attempt + 2
            );
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("operation failed: reward_detail")))
    }

    async fn fetch_reward_detail(
        &self,
        condition_id: B256,
    ) -> Result<Option<RewardDetailSnapshot>> {
        let mut last_error = None;

        for attempt in 0..config::MAX_RETRIES {
            let request = || async {
                let response = self
                    .http
                    .get(format!(
                        "{}/rewards/markets/{}",
                        config::CLOB_HOST,
                        condition_id
                    ))
                    .send()
                    .await?;
                let response = response.error_for_status()?;
                let page = response.json::<Page<RewardDetailResponse>>().await?;
                Ok::<_, reqwest::Error>(page.data.into_iter().next().map(|detail| {
                    RewardDetailSnapshot {
                        condition_id: detail.condition_id.unwrap_or(condition_id),
                        question: detail.question,
                        market_slug: detail.market_slug,
                        rewards_max_spread: detail.rewards_max_spread,
                        rewards_min_size: detail.rewards_min_size,
                        market_competitiveness: detail.market_competitiveness,
                    }
                }))
            };

            match timeout(config::operation_timeout(), request()).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(err)) => {
                    let retryable = is_retryable_http(&err);
                    last_error = Some(anyhow::Error::new(err));

                    if !retryable || attempt + 1 == config::MAX_RETRIES {
                        break;
                    }
                }
                Err(err) => {
                    last_error = Some(anyhow::Error::new(err));
                }
            }

            sleep(config::retry_delay(attempt)).await;
            eprintln!(
                "warning: retrying reward detail fetch for {condition_id} attempt {}",
                attempt + 2
            );
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("operation failed: reward_detail")))
    }
}

fn normalize_reward(reward: CurrentRewardResponse) -> RewardProgram {
    let reward_daily_rate = reward
        .rewards_config
        .iter()
        .fold(dec!(0), |acc, config| acc + config.rate_per_day);

    RewardProgram {
        condition_id: reward.condition_id,
        reward_daily_rate,
        rewards_min_size: reward.rewards_min_size,
        rewards_max_spread: reward.rewards_max_spread,
        market_competitiveness: None,
    }
}

fn normalize_market(market: Market) -> Option<MarketSnapshot> {
    let condition_id = market.condition_id?;
    let token_ids = market.clob_token_ids.unwrap_or_default();
    let outcomes = market.outcomes.unwrap_or_default();

    let tokens = token_ids
        .into_iter()
        .enumerate()
        .map(|(idx, token_id)| OutcomeToken {
            token_id,
            outcome: outcomes
                .get(idx)
                .cloned()
                .unwrap_or_else(|| format!("OUTCOME_{}", idx + 1)),
        })
        .collect();

    let tags = market
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| MarketTag {
            slug: tag.slug,
            label: tag.label,
        })
        .collect();

    let first_event = market
        .events
        .as_ref()
        .and_then(|events| events.first())
        .map(normalize_event_summary);

    Some(MarketSnapshot {
        condition_id,
        question: market
            .question
            .unwrap_or_else(|| format!("market-{condition_id}")),
        image: market.image,
        market_slug: market.slug,
        event_slug: market
            .events
            .as_ref()
            .and_then(|events| events.first())
            .and_then(|event| event.slug.clone()),
        tags,
        tokens,
        active: market.active,
        accepting_orders: market.accepting_orders,
        enable_order_book: market.enable_order_book,
        closed: market.closed,
        archived: market.archived,
        start_date: market.start_date,
        end_date: market.end_date,
        game_start_time: parse_datetime_string(market.game_start_time.as_deref()),
        event_start_time: market.event_start_time,
        first_event,
    })
}

fn normalize_event_summary(event: &Event) -> EventSummary {
    EventSummary {
        start_time: event.start_time.or(event.start_date),
        live: event.live,
        ended: event.ended,
        closed: event.closed,
    }
}

fn normalize_book(book: OrderBookSummaryResponse) -> BookSnapshot {
    let mut bids: Vec<BookLevel> = book
        .bids
        .into_iter()
        .map(|level| BookLevel {
            price: level.price,
            size: level.size,
        })
        .collect();
    bids.sort_by(|left, right| right.price.cmp(&left.price));

    let mut asks: Vec<BookLevel> = book
        .asks
        .into_iter()
        .map(|level| BookLevel {
            price: level.price,
            size: level.size,
        })
        .collect();
    asks.sort_by(|left, right| left.price.cmp(&right.price));

    BookSnapshot {
        token_id: book.asset_id,
        bids,
        asks,
        tick_size: Decimal::from(book.tick_size),
    }
}

fn parse_datetime_string(value: Option<&str>) -> Option<DateTime<Utc>> {
    value.and_then(|raw| {
        DateTime::parse_from_rfc3339(raw)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    })
}

fn is_retryable(err: &SdkError) -> bool {
    if err.kind() == ErrorKind::Internal {
        return true;
    }

    if err.kind() != ErrorKind::Status {
        return false;
    }

    err.downcast_ref::<Status>()
        .map(|status| {
            status.status_code == StatusCode::TOO_MANY_REQUESTS
                || status.status_code.is_server_error()
        })
        .unwrap_or(false)
}

fn is_retryable_http(err: &reqwest::Error) -> bool {
    err.is_timeout()
        || err
            .status()
            .map(|status| {
                status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use polymarket_client_sdk::clob::types::{
        response::OrderBookSummaryResponse, response::OrderSummary, TickSize,
    };
    use polymarket_client_sdk::types::{B256, U256};
    use rust_decimal_macros::dec;
    use serde_json::json;

    use super::{normalize_book, normalize_reward, parse_datetime_string};
    use polymarket_client_sdk::clob::types::response::CurrentRewardResponse;

    #[test]
    fn parses_rfc3339_but_rejects_date_only() {
        assert!(parse_datetime_string(Some("2026-04-06T09:00:00Z")).is_some());
        assert!(parse_datetime_string(Some("2026-04-06")).is_none());
    }

    #[test]
    fn sums_reward_rates() {
        let reward: CurrentRewardResponse = serde_json::from_value(json!({
            "condition_id": format!("0x{}", "00".repeat(32)),
            "rewards_config": [
                {
                    "asset_address": format!("0x{}", "00".repeat(20)),
                    "start_date": "2026-04-01",
                    "end_date": "2026-04-30",
                    "rate_per_day": "2",
                    "total_rewards": "60"
                },
                {
                    "asset_address": format!("0x{}", "00".repeat(20)),
                    "start_date": "2026-04-01",
                    "end_date": "2026-04-30",
                    "rate_per_day": "3",
                    "total_rewards": "90"
                }
            ],
            "rewards_max_spread": "3.5",
            "rewards_min_size": "50"
        }))
        .unwrap();

        let normalized = normalize_reward(reward);
        assert_eq!(normalized.reward_daily_rate, dec!(5));
        assert_eq!(normalized.market_competitiveness, None);
    }

    #[test]
    fn sorts_book_levels_to_best_prices_first() {
        let book = normalize_book(
            OrderBookSummaryResponse::builder()
                .market(B256::ZERO)
                .asset_id(U256::from(1u64))
                .timestamp(Utc.with_ymd_and_hms(2026, 4, 16, 0, 0, 0).unwrap())
                .bids(vec![
                    OrderSummary::builder()
                        .price(dec!(0.01))
                        .size(dec!(10))
                        .build(),
                    OrderSummary::builder()
                        .price(dec!(0.23))
                        .size(dec!(20))
                        .build(),
                    OrderSummary::builder()
                        .price(dec!(0.22))
                        .size(dec!(30))
                        .build(),
                ])
                .asks(vec![
                    OrderSummary::builder()
                        .price(dec!(0.99))
                        .size(dec!(10))
                        .build(),
                    OrderSummary::builder()
                        .price(dec!(0.24))
                        .size(dec!(20))
                        .build(),
                    OrderSummary::builder()
                        .price(dec!(0.25))
                        .size(dec!(30))
                        .build(),
                ])
                .min_order_size(dec!(5))
                .neg_risk(false)
                .tick_size(TickSize::Hundredth)
                .build(),
        );

        assert_eq!(book.bids[0].price, dec!(0.23));
        assert_eq!(book.bids[1].price, dec!(0.22));
        assert_eq!(book.bids[2].price, dec!(0.01));

        assert_eq!(book.asks[0].price, dec!(0.24));
        assert_eq!(book.asks[1].price, dec!(0.25));
        assert_eq!(book.asks[2].price, dec!(0.99));
    }
}
