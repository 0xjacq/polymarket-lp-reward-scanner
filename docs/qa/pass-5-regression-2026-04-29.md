# Pass 5 QA Regression Sweep (Production)

- Date: 2026-04-29
- URL: https://polymarket-lp-reward-scanner.vercel.app/
- Branch: `codex/qa-e2e-5passes`

## Build and Deploy

1. Build:
   - Command: `npm run build`
   - Result: success (Next.js 16.1.6, routes generated correctly).
2. Deploy:
   - Command: `vercel deploy --prod --yes`
   - Result: success, alias active on canonical URL.

## Snapshot Freshness Validation

1. Issue observed during sweep:
   - `/api/scanner` returned `snapshotHealth=stale` with warning:
     - `Snapshot is older than the 5-minute publishing cadence.`
2. Remediation executed:
   - Triggered workflow dispatch:
     - Workflow: `publish-snapshot.yml`
     - Run ID: `25121814132`
     - Branch: `codex/qa-e2e-5passes`
   - Result: success.
3. Post-fix verification:
   - `/api/scanner` meta:
     - `snapshotHealth: fresh`
     - `warning: null`
     - `generatedAt: 2026-04-29T16:50:51.701888356+00:00`
   - UI: stale/freshness warning banner absent.

## Functional Matrix (Browser Use)

1. Page load + status banners:
   - Observed: page loads, `LP details` buttons visible, no stale banner after workflow rerun.
   - Expected: no blocking errors, freshness healthy.
   - Status: pass.
2. Filters:
   - Search (`Natus`): row count narrows to relevant opportunities.
   - Tag (`Esports`): list filters correctly.
   - Min APR (`300`): list narrows as expected.
   - Status: pass.
3. Sort / Rows:
   - Sort switch `effectiveApr` -> `rewardDailyRate` changes top market order.
   - Rows switch `40` -> `80` renders 80 rows.
   - Status: pass.
4. Timing / Zone:
   - Timing `Started` toggles pressed state correctly.
   - Zone `Extreme` auto-switches sort to `twoSidedApr`.
   - Zone back to `Neutral` restores `effectiveApr`.
   - Status: pass.
5. LP details states:
   - Live case observed: market graph + order book rendered with `Live book fetched`.
   - Missing-live case observed: explicit `No live diagnostics available for this row.` message.
   - Status: pass.

## Outcome

- Blocking stale regression cleared for production by successful snapshot publish run.
- No new functional regression found in pass-5 matrix after redeploy.
