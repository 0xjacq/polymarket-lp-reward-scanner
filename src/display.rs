use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, Cell, Color, ContentArrangement, Table};
use polymarket_client_sdk::types::Decimal;

use crate::models::{DashboardRow, Opportunity, OpportunityReason, OpportunityStatus, PricingZone};

pub fn print_dashboard_json(rows: &[DashboardRow]) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(rows)?);
    Ok(())
}

pub fn print_dashboard_table(rows: &[DashboardRow]) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        "Question",
        "Reward/Day",
        "Max Spread",
        "Min Shares",
        "Comp",
        "Start",
    ]);

    for row in rows {
        table.add_row(vec![
            Cell::new(truncate(&row.question, 52)),
            Cell::new(format_decimal(row.reward_daily_rate, 2)),
            Cell::new(format!("{}c", format_decimal(row.rewards_max_spread, 2))),
            Cell::new(format_decimal(row.rewards_min_size, 2)),
            Cell::new(format_optional_decimal(row.market_competitiveness, 2)),
            Cell::new(
                row.event_start_time
                    .as_deref()
                    .map(truncate_start)
                    .unwrap_or_else(|| "-".to_string()),
            ),
        ]);
    }

    println!("{table}");
}

pub fn print_json(opportunities: &[Opportunity]) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(opportunities)?);
    Ok(())
}

pub fn print_table(opportunities: &[Opportunity]) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        "Status",
        "Reason",
        "Question",
        "Side",
        "Zone",
        "Comp",
        "Eff 1-APR",
        "Eff 2-APR",
        "Raw APR",
        "Ceiling APR",
        "Rate/Day",
        "Queue x",
        "Spread x",
        "Time",
    ]);

    for opportunity in opportunities {
        table.add_row(vec![
            status_cell(opportunity.status),
            reason_cell(opportunity.reason),
            Cell::new(truncate(&opportunity.question, 40)),
            side_cell(&opportunity.side_to_trade),
            zone_cell(opportunity.pricing_zone),
            Cell::new(format_optional_decimal(
                opportunity.market_competitiveness,
                2,
            )),
            Cell::new(format_optional_decimal(opportunity.apr_effective, 2)),
            Cell::new(format_optional_decimal(opportunity.two_sided_apr, 2)),
            Cell::new(format_optional_decimal(opportunity.apr_estimated, 2)),
            Cell::new(format_optional_decimal(opportunity.apr_ceiling, 2)),
            Cell::new(format_decimal(opportunity.reward_daily_rate, 2)),
            Cell::new(format_optional_decimal(
                opportunity.liquidity_info.queue_multiple,
                2,
            )),
            Cell::new(format_optional_decimal(opportunity.spread_ratio, 2)),
            Cell::new(&opportunity.time_to_start_human),
        ]);
    }

    println!("{table}");

    let high_apr_count = opportunities
        .iter()
        .filter(|opportunity| {
            opportunity
                .apr_effective
                .map(|apr| apr > Decimal::from(50))
                .unwrap_or(false)
        })
        .count();
    if high_apr_count > 0 {
        println!(
            "Warning: {high_apr_count} market(s) show APR > 50%; visible-book APR is likely overstated."
        );
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let truncated: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{truncated}…")
}

fn truncate_start(value: &str) -> String {
    value.replace('T', " ").replace("+00:00", "Z")
}

fn side_cell(value: &str) -> Cell {
    let mut cell = Cell::new(value);
    if value.eq_ignore_ascii_case("yes") {
        cell = cell.fg(Color::Green);
    } else if value.eq_ignore_ascii_case("no") {
        cell = cell.fg(Color::Red);
    }
    cell
}

fn zone_cell(zone: Option<PricingZone>) -> Cell {
    match zone {
        Some(PricingZone::Neutral) => Cell::new("neutral").fg(Color::Green),
        Some(PricingZone::Extreme) => Cell::new("extreme").fg(Color::Yellow),
        None => Cell::new("-"),
    }
}

fn status_cell(status: OpportunityStatus) -> Cell {
    match status {
        OpportunityStatus::CandidateNow => Cell::new("candidate").fg(Color::Green),
        OpportunityStatus::Watchlist => Cell::new("watchlist").fg(Color::Yellow),
        OpportunityStatus::Skip => Cell::new("skip").fg(Color::Red),
    }
}

fn reason_cell(reason: OpportunityReason) -> Cell {
    let label = match reason {
        OpportunityReason::InBand => "in_band",
        OpportunityReason::SpreadTooLarge => "spread_too_large",
        OpportunityReason::QueueTooThin => "queue_too_thin",
        OpportunityReason::TooCrowded => "too_crowded",
        OpportunityReason::ExtremeSingleSided => "extreme_single_sided",
        OpportunityReason::QuoteTooSmallForMinShares => "quote_too_small",
        OpportunityReason::MissingBookData => "missing_book",
        OpportunityReason::Unclear => "unclear",
    };

    match reason {
        OpportunityReason::InBand => Cell::new(label).fg(Color::Green),
        OpportunityReason::SpreadTooLarge
        | OpportunityReason::QueueTooThin
        | OpportunityReason::TooCrowded
        | OpportunityReason::Unclear => Cell::new(label).fg(Color::Yellow),
        OpportunityReason::ExtremeSingleSided
        | OpportunityReason::QuoteTooSmallForMinShares
        | OpportunityReason::MissingBookData => Cell::new(label).fg(Color::Red),
    }
}

fn format_decimal(value: Decimal, dp: u32) -> String {
    value.round_dp(dp).normalize().to_string()
}

fn format_optional_decimal(value: Option<Decimal>, dp: u32) -> String {
    value
        .map(|value| format_decimal(value, dp))
        .unwrap_or_else(|| "-".to_string())
}
