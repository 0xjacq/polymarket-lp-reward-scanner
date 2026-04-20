use anyhow::Result;
use clap::Parser;
use polymarket_client_sdk::types::Decimal;

use polymarket_lp_reward_scanner::client::PolymarketClient;
use polymarket_lp_reward_scanner::config;
use polymarket_lp_reward_scanner::models::SortField;
use polymarket_lp_reward_scanner::snapshot::{build_snapshot, SnapshotBuildConfig};

#[derive(Debug, Parser)]
#[command(name = "snapshot")]
#[command(about = "Generate a precomputed Polymarket scanner snapshot for the web app.")]
struct Args {
    #[arg(long, default_value = "1000")]
    quote_size_usdc: Decimal,

    #[arg(long, default_value = config::DEFAULT_MIN_QUEUE_MULTIPLE)]
    min_queue_multiple: Decimal,

    #[arg(long, default_value = config::DEFAULT_MIN_APR)]
    min_apr: Decimal,

    #[arg(long)]
    tag: Option<String>,

    #[arg(long, value_enum, default_value_t = SortField::Apr)]
    sort: SortField,

    #[arg(long, default_value_t = config::DEFAULT_SNAPSHOT_LIMIT)]
    limit: usize,

    #[arg(long, default_value_t = config::DEFAULT_SNAPSHOT_DASHBOARD_LIMIT)]
    dashboard_limit: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let client = PolymarketClient::new()?;
    let snapshot = build_snapshot(
        &client,
        &SnapshotBuildConfig {
            quote_size_usdc: args.quote_size_usdc,
            min_queue_multiple: args.min_queue_multiple,
            min_apr: args.min_apr,
            tag: args.tag,
            sort: args.sort,
            limit: args.limit,
            dashboard_limit: args.dashboard_limit,
        },
    )
    .await?;

    println!("{}", serde_json::to_string_pretty(&snapshot)?);
    Ok(())
}
