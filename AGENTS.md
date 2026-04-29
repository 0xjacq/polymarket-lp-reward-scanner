# Agent Instructions

This repository is designed to be easy for another AI agent to resume.

## Tooling Rules

- Always use Context7 MCP for library/framework documentation.
- Always use Exa Search MCP for web searches.
- Use LSP tools first for active code when available:
  - `mcp__lsp_bridge__*` by default.
  - `mcp__lsp_ruff__*` for Python if relevant.
- Prefer symbol/definition/reference/diagnostic tools over guessing.
- Use raw text search only for broad discovery or non-symbol text.

Known local caveat: some Codex workspaces may not expose this project root to the LSP server. If LSP reports an allowed-roots error, state that and continue with static inspection.

## Production Canonical URL

Use this URL for browser QA:

```text
https://polymarket-lp-reward-scanner.vercel.app/
```

Do not validate visual/UI work on a local Next.js server. Local commands are for build/type/data debugging only.

## Browser Use Guardrails

- Prefer `browser-use` for web QA and frontend verification; do not use desktop-wide automation unless explicitly requested by the user.
- Default QA scope is this project URL only: `https://polymarket-lp-reward-scanner.vercel.app/`.
- Localhost QA is allowed only for debugging behavior that cannot be validated on production; visual sign-off must still happen on the canonical production URL.
- Allowed without extra confirmation:
  - navigation within the allowed app pages
  - reading page content, inspecting states, and taking screenshots
  - non-destructive interactions such as filter/sort toggles, row expansion, and tab/interval switches
- Ask for explicit user confirmation before:
  - logging in or using saved credentials
  - submitting any form or any irreversible action
  - visiting a domain outside the project allowlist
  - uploading files or downloading executables
  - entering sensitive data (tokens, passwords, API keys, payment details, personal data)
- If a browser session opens an unexpected site, account page, wallet prompt, extension prompt, or permission dialog, stop immediately and ask the user how to proceed.
- In QA reports, include exact reproduction steps, observed result, expected result, and whether the issue reproduces on production.

## Development Workflow

1. Inspect relevant code first.
2. Keep Rust scanner logic as the source of truth for ranking/snapshot data.
3. Keep the web app snapshot-backed.
4. Use `/api/opportunity-detail` only for live LP details and price history.
5. Use direct browser WebSocket streaming for live orderbook updates; do not add private server-side streaming credentials.
6. Run `npm run build` before deployment.
7. Deploy to Vercel before browser QA.

## Secret Handling

Never commit:

- `.env`, `.env.local`, `.env.vercel.local`, or any `.env.*` real values.
- `.vercel/`.
- `BLOB_READ_WRITE_TOKEN`.
- GitHub, Vercel, OpenAI, or other service tokens.
- private keys, certificates, logs, `.next/`, `node_modules/`, or `target/`.

Before commit:

```bash
git status --short
git diff --cached --name-only
```

Run a secret-pattern search over staged/public files and remove anything suspicious before pushing.

## Git / Deployment Notes

- GitHub remote: `https://github.com/0xjacq/polymarket-lp-reward-scanner.git`
- Main branch: `main`
- Prefer feature branches/PRs for handoff or broad changes.
- The snapshot publisher needs GitHub Actions secret `BLOB_READ_WRITE_TOKEN`.
- Vercel needs `SNAPSHOT_PUBLIC_URL` pointing to the public Blob URL for `scanner/latest.json`.
