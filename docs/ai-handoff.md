# AI Handoff Runbook

This file is the operational context for the next AI agent.

## What This App Does

The app ranks Polymarket markets that may be attractive for LP reward farming. It separates heavy scanning from serving:

- Rust scanner computes opportunities and emits a JSON snapshot.
- GitHub Actions publishes that snapshot to Vercel Blob.
- Next.js reads the snapshot and renders the dashboard.
- LP details enrich a selected row with live orderbook data, price history, reward bands, and client-side WebSocket updates.

## Current Production Setup

- Production app: <https://polymarket-lp-reward-scanner.vercel.app/>
- GitHub repo: <https://github.com/0xjacq/polymarket-lp-reward-scanner>
- Snapshot object path: `scanner/latest.json`
- Snapshot cadence: every 5 minutes through GitHub Actions.
- Browser refresh cadence: 30 seconds.
- Stale threshold: 15 minutes.

## Data Flow

1. `src/bin/snapshot.rs` invokes the Rust snapshot builder.
2. `scripts/publish-snapshot.mjs` runs the scanner and uploads JSON to Vercel Blob.
3. `lib/snapshot.ts` loads the latest snapshot for Next.js API routes.
4. `app/api/scanner/route.ts` serves scanner rows to the browser.
5. `app/api/opportunity-detail/route.ts` fetches live CLOB book and `/prices-history` for expanded LP details.
6. `components/live-dashboard.tsx` renders the scanner and opens a WebSocket to `wss://ws-subscriptions-clob.polymarket.com/ws/market` for live book deltas.

## Important UI Behavior

- The orderbook is event-driven after the initial REST detail fetch.
- Rewarded orderbook rows are highlighted statically.
- Chart reward bands use theoretical `rewardBand` bounds, not only visible orderbook ticks.
- Price-history intervals are selectable: `1m`, `1h`, `6h`, `1d`, `1w`, `max`.
- Timestamps display in the browser's local timezone.

## Commands for a New Agent

```bash
npm ci
npm run build
cargo check
cargo test
```

Optional live snapshot smoke test:

```bash
cargo run --quiet --bin snapshot -- --limit 5
```

If that CLI option changes or fails, inspect `src/bin/snapshot.rs` and use the supported flags.

## Production Deployment

For UI changes:

1. Run `npm run build`.
2. Deploy with Vercel.
3. Test only `https://polymarket-lp-reward-scanner.vercel.app/`.

Do not use localhost as final browser QA.

## Secrets and Environment

Required outside Git:

- `BLOB_READ_WRITE_TOKEN`: GitHub Actions secret for publishing snapshots.
- `SNAPSHOT_PUBLIC_URL`: Vercel env var pointing to the public Blob URL.

Local `.env*` files and `.vercel/` are intentionally ignored and must not be committed.

## Known Gaps

- Reward scoring is an approximation, not the full documented `Q_one/Q_two/Q_min` methodology.
- The exact scoring refactor is documented in `ROADMAP.md`.
- The UI has no formal component test suite yet; build and production browser QA are the current gate.

## Safe Commit Checklist

Before pushing:

```bash
git status --short
git diff --cached --name-only
```

Confirm staged files do not include:

- `.env*`
- `.vercel/`
- `.next/`
- `node_modules/`
- `target/`
- tokens, private keys, certificates, logs, or machine-local files
