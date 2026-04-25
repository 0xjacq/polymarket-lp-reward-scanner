# Napolyrewardfarmor Roadmap

## Deferred: Doc-Compatible Liquidity Rewards Scoring

Reference documentation for the deferred refactor:
- Polymarket Help Center: https://help.polymarket.com/en/articles/13364466-liquidity-rewards
- Polymarket developer docs: https://docs.polymarket.com/market-makers/liquidity-rewards

These references document:
- the adjusted-midpoint reward concept
- the order scoring function `S(v, s)`
- the `Q_one`, `Q_two`, and `Q_min` methodology
- the neutral vs extreme zone treatment
- the single-sided scaling factor `c = 3.0`
- the epoch-based normalization flow

Current implementation is intentionally approximate for single-sided market selection:
- it scores the visible book on the chosen token
- it applies the single-sided `/3` penalty in the neutral zone
- it excludes extreme-zone single-sided candidates
- it nudges a quote one tick inside the reward band when the discretized floor lands exactly on
  the lower reward boundary and would otherwise get zero score weight

This is sufficient for scanning and ranking candidates, but it is not fully aligned with
Polymarket's documented rewards methodology.

### Why this is deferred

The documented methodology requires computing rewards across both complementary books and
deriving `Q_one`, `Q_two`, and `Q_min` before normalizing against market-wide competition.
That is a larger refactor than the current scanner architecture and is not required for basic
candidate discovery.

### Gap vs documented methodology

The current bot does **not** yet implement:
- true `Q_one` using bids on one side plus asks on the complement
- true `Q_two` using asks on one side plus bids on the complement
- exact `Q_min` calculation:
  - neutral zone: `max(min(Q_one, Q_two), max(Q_one / c, Q_two / c))`
  - extreme zone: `min(Q_one, Q_two)`
- visible competition modeled across both complementary books
- APR effective derived from true `Q_min` rather than a simplified single-sided adjustment

### Planned refactor

1. Introduce paired market-book scoring.
   - Group YES and NO books into one market-scoring unit.
   - Score a chosen side together with its complement.

2. Add complement-price transformations.
   - Convert complement asks into implied bids on the chosen side.
   - Convert complement bids into implied asks on the chosen side where required.

3. Implement documented score components.
   - `S(v, s) = ((v - s) / v)^2`
   - `Q_one`
   - `Q_two`
   - `Q_min`

4. Replace simplified effective APR.
   - Compute our visible `Q_min`
   - Compute visible competition `Q_min`
   - Estimate APR from relative `Q_min` share

5. Expand tests.
   - Cases where `Q_one != Q_two`
   - Neutral-zone single-sided penalty through `Q_min`
   - Extreme-zone behavior
   - Complement-book transformations

### Notes

- CLOB rewards remains the source of truth for `rewards_min_size`, `rewards_max_spread`,
  and active `rate_per_day` values.
- Gamma is still used for market metadata, tags, and event timing.
- The one-tick inward nudge only applies when `ceil(midpoint - band)` sits exactly on the reward
  boundary. If there is no positive-weight, non-crossing tick inside the band, the scanner leaves
  the market non-actionable instead of manufacturing APR from a zero-weight quote.
- This refactor should be done only after the current scanner workflow is considered stable.
