# Polymarket LP Reward Scanner

Public handoff repository for the Polymarket liquidity-provider reward scanner at:

- Production: <https://polymarket-lp-reward-scanner.vercel.app/>
- GitHub: <https://github.com/0xjacq/polymarket-lp-reward-scanner>

The project has two cooperating parts:

- Rust scanner: fetches Polymarket reward markets, books, timing metadata, spread/queue state, APR estimates, and emits a snapshot.
- Next.js dashboard: reads the latest published snapshot, shows ranked LP opportunities, and opens live LP details with Polymarket CLOB orderbook streaming and price-history charts.

Production is snapshot-backed. The app does not run the full Rust scanner on every web request.

## Architecture

1. Rust fetches CLOB/Gamma/rewards data and builds one JSON snapshot.
2. GitHub Actions runs `npm run snapshot:publish` every 5 minutes.
3. `scripts/publish-snapshot.mjs` generates the snapshot and uploads it to Vercel Blob at `scanner/latest.json`.
4. Vercel serves the Next.js app.
5. The app reads the snapshot through `SNAPSHOT_PUBLIC_URL`.
6. Browser clients poll the app every 30 seconds.
7. LP details fetch a live REST orderbook once, then subscribe directly to Polymarket's public CLOB WebSocket for event-driven book updates.

## Repository Layout

- `src/`: Rust scanner, filters, scoring, models, snapshot builder, and CLIs.
- `app/`: Next.js routes and API endpoints.
- `components/`: dashboard UI and shadcn-style primitives.
- `lib/`: snapshot loading, LP detail computation, orderbook utilities, shared UI helpers.
- `scripts/publish-snapshot.mjs`: snapshot generation and Vercel Blob upload.
- `docs/vercel-snapshot.md`: production snapshot, Vercel, and GitHub Actions runbook.
- `docs/ai-handoff.md`: operational context for the next AI agent.
- `ROADMAP.md`: known scoring gaps and deferred reward-methodology refactor.
- `AGENTS.md`: project-specific AI instructions.

## Requirements

- Node.js 22+
- npm
- Rust stable
- Vercel CLI only for deployment operations

## Commands

```bash
npm ci
npm run build
cargo check
cargo test
```

Generate a snapshot locally:

```bash
npm run snapshot:generate -- --quote-size-usdc 1000
```

Publish the snapshot to Vercel Blob:

```bash
BLOB_READ_WRITE_TOKEN=... npm run snapshot:publish
```

Use local dev only for implementation/debugging, not visual QA sign-off:

```bash
npm run dev
```

## Environment

Never commit real env files. Required runtime configuration is:

- GitHub Actions secret: `BLOB_READ_WRITE_TOKEN`
- Vercel environment variable: `SNAPSHOT_PUBLIC_URL`

Optional scanner tuning variables are documented in [docs/vercel-snapshot.md](docs/vercel-snapshot.md).

The snapshot loader precedence is:

1. `SNAPSHOT_LOCAL_PATH`
2. `SNAPSHOT_PUBLIC_URL`
3. Vercel Blob lookup with `BLOB_READ_WRITE_TOKEN`

Production should use `SNAPSHOT_PUBLIC_URL`; the Vercel runtime should not depend on Blob write credentials.

## Production QA

The canonical browser QA target is:

```text
https://polymarket-lp-reward-scanner.vercel.app/
```

For UI changes:

1. Run `npm run build`.
2. Deploy to the linked Vercel project.
3. Test only the canonical Vercel URL in the browser.

Do not use `localhost` as the final visual QA target.

## Security

This repo is public. Do not publish:

- `.env*` files with real values.
- `.vercel/`.
- Vercel, GitHub, Blob, OpenAI, or other service tokens.
- private keys, certificates, local logs, generated build directories, or machine-specific files.

Before staging, run a secret scan and verify `git diff --cached --name-only`.

## Current Product Notes

- Scanner scoring is intentionally approximate for single-sided LP selection.
- The live orderbook in LP details uses Polymarket public WebSocket events in the browser.
- Price history uses Polymarket `/prices-history` with selectable intervals.
- Browser timestamps use the client locale/timezone.
- Further scoring accuracy work is tracked in [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
