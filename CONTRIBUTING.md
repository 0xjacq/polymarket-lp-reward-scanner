# Contributing

## Development Expectations

- Keep Rust as the source of truth for scanner logic, APR logic, and snapshot generation
- Keep the web app snapshot-backed; do not add live Polymarket recomputation to Next.js
- Keep changes scoped and avoid unrelated refactors

## Setup

```bash
npm ci
cargo test
npm run build
```

Use `.env.local` only for local development. Never commit secrets or local linkage files.

## Pull Requests

Before opening a PR:

- run `cargo test`
- run `npm run build`
- confirm no secrets, `.env*` values, `.vercel/`, build output, or local machine artifacts are staged
- update docs when behavior, runtime config, or deployment flow changes

## Issues

Use issues for bugs, feature requests, and deployment/documentation gaps.
