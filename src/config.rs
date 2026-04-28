use std::time::Duration;

pub const CLOB_HOST: &str = "https://clob.polymarket.com";
pub const GAMMA_HOST: &str = "https://gamma-api.polymarket.com";

pub const DEFAULT_MIN_HOURS: u64 = 1;
pub const DEFAULT_MIN_QUEUE_MULTIPLE: &str = "2";
pub const DEFAULT_MIN_APR: &str = "0";
pub const DEFAULT_LIMIT: usize = 20;
pub const DEFAULT_SNAPSHOT_LIMIT: usize = 200;
pub const DEFAULT_SNAPSHOT_DASHBOARD_LIMIT: usize = 100;
pub const BOOK_SHORTLIST_MULTIPLIER: usize = 10;
pub const BOOK_SHORTLIST_MIN: usize = 500;
pub const COMPETITIVENESS_SHORTLIST_MULTIPLIER: usize = 5;
pub const COMPETITIVENESS_SHORTLIST_MIN: usize = 300;
pub const SINGLE_SIDED_PENALTY: u32 = 3;
pub const APR_UPPER_BAND_FRACTION: f64 = 0.45;
pub const APR_LOWER_BAND_FRACTION: f64 = 0.10;

pub const GAMMA_BATCH_SIZE: usize = 50;
pub const GAMMA_CONCURRENCY: usize = 8;
pub const GAMMA_PAGE_SIZE: i32 = 500;
pub const GAMMA_PAGINATION_FALLBACK_THRESHOLD: usize = 100;
pub const GAMMA_PAGINATION_DIRECT_THRESHOLD: usize = 1000;
pub const REWARD_DETAIL_CONCURRENCY: usize = 8;
pub const INITIAL_BOOK_BATCH_SIZE: usize = 100;
pub const BOOK_CONCURRENCY: usize = 8;
pub const MAX_RETRIES: usize = 3;

pub const CURSOR_DONE: &str = "LTE=";

pub fn operation_timeout() -> Duration {
    Duration::from_secs(60)
}

pub fn retry_delay(attempt: usize) -> Duration {
    let millis = 250_u64.saturating_mul(1_u64 << attempt.min(4));
    Duration::from_millis(millis)
}
