# Polymarket LP Reward Scanner

Snapshot-backed scanner and dashboard for Polymarket liquidity reward programs.

The project uses Rust for market fetching, reward analysis, APR scoring, queue/spread evaluation, and snapshot generation. A small Next.js app serves the latest precomputed snapshot and provides two views:

- `Opportunities`: tradeable or watchlist rows with APR, queue, spread, status, and timing
- `Dashboard`: reward markets overview sorted by reward rate and timing metadata

## Architecture

Production is designed around a precomputed snapshot, not per-request scanner execution:

1. Rust fetches rewards, markets, details, competitiveness, and books
2. Rust emits one JSON snapshot containing dashboard rows and both opportunity datasets
3. GitHub Actions publishes that snapshot to Vercel Blob at `scanner/latest.json`
4. The Vercel app reads the latest snapshot through `SNAPSHOT_PUBLIC_URL`
5. Browsers poll the app every 30 seconds while the authoritative snapshot cadence remains 5 minutes

## Repository Layout

- `src/`: Rust scanner, filters, scoring, models, snapshot builder, and CLIs
- `app/`, `components/`, `lib/`: Next.js frontend and snapshot-backed API routes
- `scripts/publish-snapshot.mjs`: snapshot generation + Blob upload entrypoint
- `docs/vercel-snapshot.md`: Vercel, Blob, and GitHub Actions deployment guide
- `.github/workflows/publish-snapshot.yml`: scheduled publish workflow

## Local Development

### Requirements

- Rust stable
- Node.js 22+
- npm

### Install

```bash
npm ci
```

### Run against a real published snapshot

Create `.env.local`:

```bash
SNAPSHOT_PUBLIC_URL=https://.../scanner/latest.json
```

Then start the app:

```bash
npm run dev
```

### Run against an explicit local snapshot file

Generate a snapshot:

```bash
cargo run --quiet --bin snapshot -- --quote-size-usdc 1000 > /tmp/polymarket-lp-reward-scanner-snapshot.json
```

Start the app with that file:

```bash
SNAPSHOT_LOCAL_PATH=/tmp/polymarket-lp-reward-scanner-snapshot.json npm run dev
```

### Run against the synthetic mock fixture

```bash
npm run dev:mock-snapshot
```

This uses the committed synthetic fixture at `fixtures/mock-snapshot.json`.

## Production Deployment

Production uses:

- Vercel for the web app
- Vercel Blob for the latest snapshot object
- GitHub Actions for scheduled snapshot publishing

Required configuration:

- GitHub Actions secret: `BLOB_READ_WRITE_TOKEN`
- Vercel environment variable: `SNAPSHOT_PUBLIC_URL`

Detailed setup steps live in [docs/vercel-snapshot.md](docs/vercel-snapshot.md).

## Security

Do not commit:

- `.env` files with real values
- `.vercel/`
- Blob, GitHub, or Vercel tokens
- generated snapshots unless intentionally used as test fixtures

Report security issues through the process in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request expectations.

## License

[MIT](LICENSE)
