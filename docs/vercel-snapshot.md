# Vercel Snapshot Deployment

## Overview

The frontend serves a precomputed snapshot instead of calling Polymarket live on each request.

- Rust remains the source of truth for APR, status, reason, queue, and spread logic.
- A GitHub Actions worker runs every 5 minutes.
- The worker uploads the latest JSON snapshot to Vercel Blob at `scanner/latest.json`.
- The Vercel app reads that snapshot through `SNAPSHOT_PUBLIC_URL` and polls every 30 seconds.
- If a publish run fails, Blob keeps the last good `scanner/latest.json` object and the UI simply becomes stale.

## Frontend Environment

Production Vercel should use:

- `SNAPSHOT_PUBLIC_URL=https://.../scanner/latest.json`

The loader precedence remains:

1. `SNAPSHOT_LOCAL_PATH`
2. `SNAPSHOT_PUBLIC_URL`
3. Blob path lookup

Do not set `SNAPSHOT_LOCAL_PATH` in Vercel.
Do not rely on `BLOB_READ_WRITE_TOKEN` in the Vercel app runtime for the normal production path.

For local browser testing with real published data, create `.env.local` with:

```bash
SNAPSHOT_PUBLIC_URL=https://.../scanner/latest.json
```

Use `npm run dev:mock-snapshot` only when you intentionally want the committed synthetic fixture at `fixtures/mock-snapshot.json`.

## Worker Environment

GitHub Actions secret:

- `BLOB_READ_WRITE_TOKEN=...`

Worker environment defaults:

- `SNAPSHOT_BLOB_PATH=scanner/latest.json`

Optional tuning:

- `SNAPSHOT_QUOTE_SIZE_USDC=1000`
- `SNAPSHOT_LIMIT=200`
- `SNAPSHOT_DASHBOARD_LIMIT=100`
- `SNAPSHOT_MIN_QUEUE_MULTIPLE=2`
- `SNAPSHOT_MIN_APR=0`

## GitHub Actions Setup

The workflow lives at the standalone repo root in `.github/workflows/publish-snapshot.yml`.

It runs on:

- `schedule` every 5 minutes
- `workflow_dispatch` for manual publishes

Each run does:

- checkout
- Node setup
- Rust stable setup
- npm cache
- Rust cache
- `npm ci`
- `npm run snapshot:publish`

The publish step is success-only:

- generate the full snapshot
- upload with overwrite to `scanner/latest.json`
- if generation or upload fails, keep the previous Blob object untouched

## Manual Publish

You can trigger a first publish through GitHub Actions `workflow_dispatch`.

After the first successful publish:

- copy the printed Blob `url`
- set that value as Vercel `SNAPSHOT_PUBLIC_URL`
- redeploy or refresh the Vercel environment

The publish script output includes the final Blob pathname and URL:

```bash
npm run snapshot:publish
```

## Local Development

Real published snapshot in local dev:

1. Put `SNAPSHOT_PUBLIC_URL` in `.env.local`
2. Run:

   ```bash
   npm run dev
   ```

Explicit synthetic fixture:

```bash
npm run dev:mock-snapshot
```

Explicit local generated file:

```bash
cargo run --bin snapshot -- --quote-size-usdc 1000 > /tmp/polymarket-lp-reward-scanner-snapshot.json
SNAPSHOT_LOCAL_PATH=/tmp/polymarket-lp-reward-scanner-snapshot.json npm run dev
```

## Freshness and Stale State

- Browser refresh cadence: 30 seconds
- Snapshot publish cadence: 5 minutes
- Snapshot stale threshold: 15 minutes

If the snapshot is older than 15 minutes, the UI shows a stale warning but keeps rendering the last published data.

## Troubleshooting

If local dev says Blob access is not configured:

- set `SNAPSHOT_PUBLIC_URL` in `.env.local` for real published data
- or set `BLOB_READ_WRITE_TOKEN` only if you want direct Blob reads
- or use `npm run dev:mock-snapshot` for the explicit fixture

If Vercel shows stale data for too long:

- check the latest GitHub Actions run
- confirm `BLOB_READ_WRITE_TOKEN` is still valid
- confirm the published Blob URL in `SNAPSHOT_PUBLIC_URL` still points to `scanner/latest.json`

`scanner/latest.json` is the only production snapshot contract in this setup. Historical retention is out of scope for this pass.
