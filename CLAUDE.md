# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket LP Reward Scanner — identifies markets eligible for liquidity-provider reward farming. Two cooperating parts:

- **Rust scanner**: Fetches Polymarket reward markets, order books, timing metadata, spread/queue state, APR estimates, and emits a JSON snapshot.
- **Next.js dashboard**: Reads the latest published snapshot, shows ranked LP opportunities, and provides live LP detail panels with CLOB orderbook WebSocket streaming and price-history charts.

Production: `https://polymarket-lp-reward-scanner.vercel.app/` — snapshot-backed; the app does not run the full Rust scanner on every web request.

## Build & Test Commands

```bash
# Rust
cargo check          # type-check only
cargo test           # all tests (unit tests are inline in src/ files)
cargo build          # full build

# Next.js
npm ci               # install dependencies
npm run build        # production build (required before deployment)
npm run dev          # local dev server (for debugging only — not visual QA)

# Generate a snapshot locally
npm run snapshot:generate -- --quote-size-usdc 1000

# Publish snapshot to Vercel Blob (requires BLOB_READ_WRITE_TOKEN)
npm run snapshot:publish
```

There are no lint scripts; `cargo check` and `npm run build` serve as the compile/type gate.

## Rust Architecture

Two binaries defined in `Cargo.toml` (implicitly via `src/main.rs` and `src/bin/snapshot.rs`):

- **`napolyrewardfarmor`** (`src/main.rs`): Interactive CLI scanner. Fetches rewards, filters eligible markets, fetches order books, runs scoring, and outputs a table or JSON. Supports `--dashboard`, `--two-sided`, `--json`, `--tag`, `--sort` flags.
- **`snapshot`** (`src/bin/snapshot.rs`): Generates the JSON snapshot consumed by the web app. Outputs JSON to stdout; the publish script (`scripts/publish-snapshot.mjs`) captures this and uploads to Vercel Blob.

**Key source files:**

| File | Role |
|---|---|
| `src/config.rs` | All tunable constants: API hosts, timeouts, concurrency limits, batch sizes, retry counts, shortlist multipliers |
| `src/client.rs` | Polymarket API client wrapping CLOB SDK, Gamma SDK, and raw HTTP. Handles pagination, retries with exponential backoff, batch fetching with concurrency |
| `src/models.rs` | Core data types: `RewardProgram`, `MarketSnapshot`, `BookSnapshot`, `EligibleMarket`, `Opportunity` (with `LiquidityInfo`), `DashboardRow`, enums for status/reason/zone/sort |
| `src/filters.rs` | Eligibility filtering: validates market is active, has 2 tokens, has positive reward params, matches tag, resolves event start time. Two filter modes: `filter_eligible` (excludes live-started) and `filter_snapshot_eligible` (includes live-started) |
| `src/scoring.rs` | Core scoring engine: adjusted midpoint, reward band computation, reward-floor price, suggested bid price, queue analysis, score-weight function `S(v,s)`, visible-book competition, APR estimation, effective APR with single-sided penalty. Sorting and comparison logic for the three status buckets |
| `src/snapshot.rs` | Snapshot builder orchestrating the full scan pipeline: fetch → filter → two-pass scoring with competitiveness P90 → enrich with market metadata → build dashboard and opportunity rows |
| `src/display.rs` | Terminal output formatting for CLI table and JSON modes |

**Scoring pipeline (two-pass):**

1. **First pass**: Score all eligible markets without competitiveness data. Shortlist top candidates.
2. **Fetch competitiveness**: Only for shortlisted condition IDs (cost-saving — competitiveness is a per-market API call).
3. **Second pass**: Re-score with competitiveness P90 threshold, filter by min APR, truncate to limit.

The scoring model is intentionally approximate for single-sided LP selection. It applies a `/3` penalty in the neutral pricing zone and excludes extreme-zone (price < 0.10 or > 0.90) single-sided candidates. Full `Q_one/Q_two/Q_min` methodology is deferred (see ROADMAP.md).

## Next.js Architecture

- **Framework**: Next.js 16 (App Router) with React 19, TypeScript, Tailwind CSS v4, Radix UI primitives, lightweight-charts.
- **Routes**:
  - `GET /api/scanner` — serves scanner opportunity rows from the snapshot
  - `GET /api/opportunity-detail` — live LP detail: fetches REST orderbook from Polymarket CLOB, fetches price history, computes full diagnostic payload
  - `GET /api/dashboard` — serves dashboard summary rows
- **Page**: `app/page.tsx` — server component, loads initial snapshot, renders `LiveDashboard`

**Key frontend files:**

| File | Role |
|---|---|
| `lib/snapshot.ts` | Snapshot loading with fallback chain: `SNAPSHOT_LOCAL_PATH` → `SNAPSHOT_PUBLIC_URL` → Vercel Blob. Caches last good snapshot in memory for resilience. Freshness tracking |
| `lib/opportunity-detail.ts` | Reimplements the Rust scoring math in TypeScript for live LP detail computation. Fetches live CLOB book and price history from Polymarket REST endpoints |
| `lib/orderbook-utils.ts` | Orderbook depth building, level normalization, delta application for WebSocket updates |
| `components/live-dashboard.tsx` | Single-page client component. 30-second polling for snapshot refresh. Expandable LP detail panels with WebSocket orderbook streaming (`wss://ws-subscriptions-clob.polymarket.com/ws/market`). Client-side filtering/sorting/search. Price history chart with reward band overlay |
| `scripts/publish-snapshot.mjs` | Runs `cargo run --bin snapshot` and uploads JSON to Vercel Blob at `scanner/latest.json` |

**Snapshot flow**: Rust `snapshot` binary → stdout JSON → `publish-snapshot.mjs` uploads to Vercel Blob → `lib/snapshot.ts` reads it → Next.js API routes serve it → browser polls `/api/scanner` every 30s.

## Environment Variables

- `SNAPSHOT_PUBLIC_URL` — public Vercel Blob URL for `scanner/latest.json` (set in Vercel)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read-write token (GitHub Actions secret only)
- `SNAPSHOT_LOCAL_PATH` — local JSON file path for dev (overrides all other sources)
- Optional tuning: `SNAPSHOT_QUOTE_SIZE_USDC`, `SNAPSHOT_LIMIT`, `SNAPSHOT_DASHBOARD_LIMIT`, `SNAPSHOT_MIN_QUEUE_MULTIPLE`, `SNAPSHOT_MIN_APR`

Never commit `.env*` files, `.vercel/`, `.next/`, `node_modules/`, or `target/`.

## Deployment

- GitHub Actions runs `npm run snapshot:publish` every 5 minutes
- Vercel deploys the Next.js app from the same repo
- Before committing, run `cargo test` and `npm run build`
- Browser QA must use the canonical Vercel URL, not localhost
