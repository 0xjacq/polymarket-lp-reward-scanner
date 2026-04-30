# QA Regression Sweep (Production)

- Date (UTC): 2026-04-30
- Sweep start (UTC): 2026-04-30T03:41:35Z
- Canonical URL: https://polymarket-lp-reward-scanner.vercel.app/
- Branch: `main`
- Commit tested/deployed: `abfbb60`
- Release gate: **No open P0/P1**

## Build + Deploy Preflight

1. Local build
   - Command: `npm run build`
   - Result: pass (Next.js 16.1.6, TypeScript pass, routes generated)
2. Production deploy
   - Command: `vercel deploy --prod --yes`
   - Result: pass
   - Inspect URL: `https://vercel.com/jacqs-projects-ec2121d1/polymarket-lp-reward-scanner/JE2SeisxufgrbkwwLWwvDt7dkSRc`
   - Production URL: `https://polymarket-lp-reward-scanner-qrrrlyjz8-jacqs-projects-ec2121d1.vercel.app`
   - Alias confirmed: `https://polymarket-lp-reward-scanner.vercel.app`

## API Contract + Data Coherence

### `/api/scanner` contract

- `meta` keys present: `generatedAt, scanDurationMs, sourceVersion, quoteSizeUsdc, minQueueMultiple, competitivenessP90, snapshotSource, snapshotHealth, snapshotAgeMs, staleAfterMs, warning`
- `neutral.rows` and `extreme.rows` are arrays
- Row keyset verified on both datasets (includes all expected fields used by UI)

### Freshness and timing

- Earlier sample in this sweep (pre-deploy reload):
  - `snapshotHealth: stale`
  - `warning: "Snapshot is older than the 5-minute publishing cadence."`
- Current post-deploy sample:
  - `generatedAt: 2026-04-30T04:26:18.152686128+00:00`
  - `snapshotHealth: fresh`
  - `snapshotAgeMs: 359212`
  - `warning: null`
- Timing coherence check:
  - `upcoming_with_past_start` (API check): `0`

### `/api/opportunity-detail` behavior

1. Success path
   - Valid `marketId/tokenId` returns `200` with populated detail payload (`priceHistory`, `depth`, APR fields, status/reason)
2. Error path
   - Invalid `marketId/tokenId` returns `404`
   - Payload: `{ "error": "Opportunity not found in the current snapshot." }`

## Production UI Regression Matrix

### Baseline structure + visual coherence (desktop)

- Row count baseline: `40`
- Header row present: `1`
- Column headers present and scoped in table header:
  - `Market, Tags, APR 1-sided, APR 2-sided, Reward/day, Queue x, Spread x, Comp, Price, Time, Actions` => all present exactly once
- Explicit row cell structure counts match rows:
  - `.market-cell/.tags-cell/.price-cell/.time-cell/.actions-cell` each count `40`
- Market identifier presence:
  - `.heading-text h2` count `40`
  - empty titles `0`
  - fallback placeholders currently shown `0`
- Desktop visual check:
  - No observed overlap in `Price/Time/Actions`
  - Header-to-value semantic alignment observed as correct

### Filters and controls

1. Search
   - Query `Natus` -> rows `40 -> 4`
   - Clear search -> back to baseline
2. Tag filter
   - Set `Esports` -> rows remain `40` (current dataset has >=40 matches)
   - Composition under filter verified: rows with `ESPORTS` `40/40`
3. Min APR
   - `300` -> rows `40 -> 3`
   - Reset `0` -> back to baseline
4. Sort
   - `effectiveApr` first row: `Pistons vs. Magic`
   - `soonest` first row: `Shymkent 2: Sergey Fomin vs Max Hans Rehberg` (ordering changes as expected)
   - `rewardDailyRate` first reward cell available and populated
5. Rows selector
   - `40 -> 80 -> 40` verified
6. Timing toggles
   - `Upcoming`: `40` rows, non-matching timing badges `0`
   - `Started`: `40` rows, non-matching timing badges `0`
7. Zone toggles
   - `Extreme` switches sort selected option to `Effective APR (2-sided)`
   - `Neutral` switches sort selected option back to `Effective APR (1-sided)`

### LP details flow

- Details open/close: pass
- Live details available path: pass
  - `Live book fetched ...` visible
  - Market graph and detailed panel visible
- Error panel on valid row: not observed
- Fallback UI states (`temporarily unavailable` / `No live diagnostics ...`) on current snapshot: not reproduced in 40-row scan

### Empty results state

- Search `zzzzzzzzzzzzzzzzzz-no-match`
- Row count `0`
- Empty-state copy shown: `No opportunity rows match the current filters.`

## Screenshot References

- Stale-banner sample (same sweep, pre-deploy state): `/tmp/qa_prod_desktop_2026-04-30.png`
- Desktop baseline post-deploy: `/tmp/qa_prod_desktop_postdeploy_2026-04-30.png`
- LP details live state: `/tmp/qa_prod_lp_live_2026-04-30.png`

## Findings

### P0

- None.

### P1

- None.

### P2

1. Responsive viewport matrix (1280/980/760) not fully executed in this run due in-session browser viewport-resize control not being available through the exposed runtime.
   - Repro steps: N/A (test-infrastructure limitation)
   - Observed: desktop QA completed; breakpoint-specific live validation incomplete
   - Expected: run full breakpoint matrix interactively
   - Reproduces on production: N/A (not a product defect)

### P3

1. LP fallback state (`temporarily unavailable` / `No live diagnostics ...`) not reproduced after deploy on current live snapshot while success path was consistently available.
   - Repro steps: scanned details on 40 rows
   - Observed: 40/40 showed live path within wait budget
   - Expected: at least one representative fallback state for this sweep matrix
   - Reproduces on production: not reproduced in this run

## Gate Decision

- **PASS** for release gate criteria (`no open P0/P1`).
- Residual test gaps are documented as P2/P3 coverage limitations and do not block gate.
