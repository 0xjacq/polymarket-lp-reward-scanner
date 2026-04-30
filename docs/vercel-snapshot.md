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

Browser QA should use the canonical deployed Vercel app, not a local Next.js server. Local commands are limited to build/type checks and explicit data-generation debugging.

Canonical production URL:

- `https://polymarket-lp-reward-scanner.vercel.app/`

Public GitHub repository:

- `https://github.com/0xjacq/polymarket-lp-reward-scanner`

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

The snapshot publish workflow lives at `.github/workflows/publish-snapshot.yml`.

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

## Vercel QA and Deployment

For UI changes:

1. Run `npm run build` locally for compile/type validation.
2. Push or merge to `main` to trigger the GitHub -> Vercel production deployment.
3. Wait for the canonical production deployment to be ready.
4. Open `https://polymarket-lp-reward-scanner.vercel.app/` in the browser and test there.

Do not use `npm run dev`, `npm run dev:mock-snapshot`, or `SNAPSHOT_LOCAL_PATH=... npm run dev` as the browser QA path. Those are only debugging tools for isolated snapshot issues.
Do not use manual `vercel deploy` for normal releases; reserve it for explicit emergency recovery.

Before committing deployment or snapshot changes, verify that `.env*`, `.vercel/`, `.next/`, `node_modules/`, and `target/` are not staged.

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
cargo run --bin snapshot -- --quote-size-usdc 1000 > /tmp/napolyrewardfarmor-snapshot.json
SNAPSHOT_LOCAL_PATH=/tmp/napolyrewardfarmor-snapshot.json npm run dev
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
