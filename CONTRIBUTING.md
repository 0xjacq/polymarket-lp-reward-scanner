# Contributing

## Development Expectations

- Keep Rust as the source of truth for scanner logic, APR logic, and snapshot generation
- Keep the web app snapshot-backed; do not add full live Polymarket recomputation to Next.js
- Keep LP details bounded to `/api/opportunity-detail`, price history, and browser-side public CLOB streaming
- Keep changes scoped and avoid unrelated refactors
- Update docs when deployment, snapshot, scoring, or QA behavior changes

## Setup

```bash
npm ci
cargo test
npm run build
```

Use `.env.local` only for local development. Never commit secrets or local linkage files.

Production browser QA must happen on:

```text
https://polymarket-lp-reward-scanner.vercel.app/
```

Local dev servers are acceptable for debugging only, not final visual sign-off.

## Pull Requests

Before opening a PR:

- run `cargo test`
- run `npm run build`
- confirm no secrets, `.env*` values, `.vercel/`, build output, or local machine artifacts are staged
- confirm `git diff --cached --name-only` does not include `.next/`, `node_modules/`, `target/`, `.DS_Store`, logs, or env files
- update docs when behavior, runtime config, or deployment flow changes

## Issues

Use issues for bugs, feature requests, and deployment/documentation gaps.
