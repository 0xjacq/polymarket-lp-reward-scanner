import type { OpportunityRow, SnapshotMeta } from "@/lib/snapshot";

const CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const SINGLE_SIDED_PENALTY = 3;
const EPSILON = 1e-9;

export type DetailMode = "single" | "two";
export type DetailPricingZone = "neutral" | "extreme";

type RawLevel = {
  price?: unknown;
  size?: unknown;
};

type LiveBookResponse = {
  bids?: RawLevel[];
  asks?: RawLevel[];
  tick_size?: unknown;
  timestamp?: unknown;
};

type BookLevel = {
  price: number;
  size: number;
};

export type OpportunityDetailDepthLevel = {
  price: number;
  size: number;
  cumulativeShares: number;
  queueAheadShares: number;
  inBand: boolean;
  isSuggested: boolean;
};

export type OpportunityDetailPayload = {
  fetchedAt: string;
  snapshotGeneratedAt: string;
  quoteSizeUsdc: number;
  mode: DetailMode;
  bestBid: number | null;
  bestAsk: number | null;
  adjustedMidpoint: number | null;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  rewardFloorPrice: number | null;
  inBandUpperPrice: number | null;
  suggestedPrice: number | null;
  ownShares: number | null;
  minimumQualifyingUsdc: number | null;
  queueAheadShares: number | null;
  queueAheadNotional: number | null;
  queueMultiple: number | null;
  qualifyingDepthShares: number | null;
  aprCeiling: number | null;
  rawApr: number | null;
  effectiveApr: number | null;
  spreadRatio: number | null;
  distanceToAsk: number | null;
  pricingZone: DetailPricingZone | null;
  status: string;
  reason: string;
  depth: {
    bids: OpportunityDetailDepthLevel[];
    scaleMin: number;
    scaleMax: number;
  };
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLevels(value: unknown, side: "bids" | "asks"): BookLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const levels = value
    .map((entry) => {
      const level = entry as RawLevel;
      const price = toNumber(level.price);
      const size = toNumber(level.size);
      if (price === null || size === null || price <= 0 || size <= 0) {
        return null;
      }
      return { price, size };
    })
    .filter((level): level is BookLevel => level !== null);

  levels.sort((left, right) =>
    side === "bids" ? right.price - left.price : left.price - right.price
  );
  return levels;
}

function stepPrecision(step: number) {
  const text = step.toString();
  const decimalPart = text.includes(".") ? text.split(".")[1] : "";
  return decimalPart.replace(/0+$/, "").length;
}

function roundToTick(value: number, tickSize: number) {
  const precision = Math.min(6, Math.max(0, stepPrecision(tickSize)));
  return Number(value.toFixed(precision));
}

function ceilToTick(value: number, tickSize: number) {
  if (!(tickSize > 0)) {
    return value;
  }

  return roundToTick(Math.ceil((value - EPSILON) / tickSize) * tickSize, tickSize);
}

function priceAtCumulativeDepth(levels: BookLevel[], threshold: number) {
  let cumulative = 0;
  for (const level of levels) {
    cumulative += level.size;
    if (cumulative >= threshold) {
      return level.price;
    }
  }
  return null;
}

function adjustedMidpoint(
  bids: BookLevel[],
  asks: BookLevel[],
  rewardsMinSize: number
) {
  const bidPrice = priceAtCumulativeDepth(bids, rewardsMinSize) ?? bids[0]?.price ?? null;
  const askPrice = priceAtCumulativeDepth(asks, rewardsMinSize) ?? asks[0]?.price ?? null;
  if (bidPrice === null || askPrice === null) {
    return null;
  }
  return (bidPrice + askPrice) / 2;
}

function queueAheadShares(levels: BookLevel[], suggestedPrice: number) {
  return levels
    .filter((level) => level.price >= suggestedPrice - EPSILON)
    .reduce((acc, level) => acc + level.size, 0);
}

function queueAheadNotional(levels: BookLevel[], suggestedPrice: number) {
  return levels
    .filter((level) => level.price >= suggestedPrice - EPSILON)
    .reduce((acc, level) => acc + level.size * level.price, 0);
}

function qualifyingDepthShares(levels: BookLevel[], rewardFloor: number, midpoint: number) {
  return levels
    .filter(
      (level) =>
        level.price >= rewardFloor - EPSILON && level.price < midpoint - EPSILON
    )
    .reduce((acc, level) => acc + level.size, 0);
}

function scoreWeight(spreadBand: number, distance: number) {
  if (!(spreadBand > 0) || distance < -EPSILON || distance - spreadBand > EPSILON) {
    return null;
  }

  const ratio = (spreadBand - Math.max(0, distance)) / spreadBand;
  return ratio * ratio;
}

function visibleWeight(
  levels: BookLevel[],
  midpoint: number,
  spreadBand: number,
  rewardFloor: number
) {
  return levels
    .filter(
      (level) =>
        level.price >= rewardFloor - EPSILON && level.price < midpoint - EPSILON
    )
    .reduce((acc, level) => {
      const weight = scoreWeight(spreadBand, midpoint - level.price);
      return weight === null ? acc : acc + weight * level.size;
    }, 0);
}

function suggestedBidPrice(
  midpoint: number,
  spreadBand: number,
  rewardFloorPrice: number,
  tickSize: number,
  bestAsk: number
) {
  let candidate = rewardFloorPrice;

  if (
    tickSize > 0 &&
    scoreWeight(spreadBand, midpoint - candidate) === 0
  ) {
    candidate = roundToTick(candidate + tickSize, tickSize);
  }

  const score = scoreWeight(spreadBand, midpoint - candidate);
  if (score === null || score <= 0 || candidate >= bestAsk - EPSILON) {
    return null;
  }

  return candidate;
}

function effectiveApr(rawApr: number, pricingZone: DetailPricingZone, mode: DetailMode) {
  if (mode === "two") {
    return rawApr;
  }
  return pricingZone === "neutral" ? rawApr / SINGLE_SIDED_PENALTY : 0;
}

function toPricingZone(midpoint: number): DetailPricingZone {
  return midpoint >= 0.1 && midpoint <= 0.9 ? "neutral" : "extreme";
}

function compactDepth(
  bids: BookLevel[],
  rewardFloorPrice: number | null,
  adjustedMidpointPrice: number | null,
  suggestedPrice: number | null
) {
  let cumulative = 0;
  return bids.slice(0, 20).map((level) => {
    cumulative += level.size;
    return {
      price: level.price,
      size: level.size,
      cumulativeShares: cumulative,
      queueAheadShares:
        suggestedPrice === null || level.price + EPSILON < suggestedPrice
          ? 0
          : cumulative,
      inBand:
        rewardFloorPrice !== null &&
        adjustedMidpointPrice !== null &&
        level.price >= rewardFloorPrice - EPSILON &&
        level.price < adjustedMidpointPrice - EPSILON,
      isSuggested:
        suggestedPrice !== null && Math.abs(level.price - suggestedPrice) < EPSILON
    };
  });
}

function scaleBounds(values: Array<number | null>) {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) {
    return { scaleMin: 0, scaleMax: 1 };
  }

  const min = Math.max(0, Math.min(...numeric));
  const max = Math.min(1, Math.max(...numeric));
  if (max - min < 0.05) {
    const center = (max + min) / 2;
    return {
      scaleMin: Math.max(0, center - 0.05),
      scaleMax: Math.min(1, center + 0.05)
    };
  }
  return { scaleMin: min, scaleMax: max };
}

export async function fetchLiveBook(tokenId: string) {
  const url = new URL(CLOB_BOOK_URL);
  url.searchParams.set("token_id", tokenId);

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Live orderbook fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as LiveBookResponse;
  const bids = normalizeLevels(payload.bids, "bids");
  const asks = normalizeLevels(payload.asks, "asks");
  const tickSize = toNumber(payload.tick_size) ?? 0.01;
  let fetchedAt = new Date().toISOString();
  if (typeof payload.timestamp === "string" || typeof payload.timestamp === "number") {
    const numericTimestamp = Number(payload.timestamp);
    if (Number.isFinite(numericTimestamp)) {
      fetchedAt = new Date(numericTimestamp).toISOString();
    } else {
      const parsed = new Date(payload.timestamp);
      if (!Number.isNaN(parsed.getTime())) {
        fetchedAt = parsed.toISOString();
      }
    }
  }

  return {
    bids,
    asks,
    tickSize,
    fetchedAt
  };
}

export function computeOpportunityDetail(input: {
  row: OpportunityRow;
  meta: SnapshotMeta;
  mode: DetailMode;
  quoteSizeUsdc: number;
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize: number;
  fetchedAt: string;
}): OpportunityDetailPayload {
  const { row, meta, mode, quoteSizeUsdc, bids, asks, tickSize, fetchedAt } = input;
  const spreadBand = row.rewardsMaxSpread / 100;
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midpoint = adjustedMidpoint(bids, asks, row.rewardsMinSize);
  const currentSpread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const spreadRatio =
    currentSpread !== null && spreadBand > 0 ? currentSpread / spreadBand : null;
  const pricingZone = midpoint === null ? null : toPricingZone(midpoint);

  let status = "skip";
  let reason = "missing_book_data";
  let rewardFloorPrice: number | null = null;
  let suggestedPrice: number | null = null;
  let ownShares: number | null = null;
  let minimumQualifyingUsdc: number | null = null;
  let queueShares: number | null = null;
  let queueNotional: number | null = null;
  let queueMultiple: number | null = null;
  let depthShares: number | null = null;
  let distanceToAsk: number | null = null;
  let aprCeiling: number | null = null;
  let rawApr: number | null = null;
  let effectiveAprValue: number | null = null;

  if (midpoint !== null && bestAsk !== null) {
    status = "skip";
    reason = "missing_book_data";

    if (pricingZone === "extreme" && mode === "single") {
      reason = "extreme_single_sided";
    } else {
      rewardFloorPrice = ceilToTick(midpoint - spreadBand, tickSize);
      if (rewardFloorPrice < tickSize) {
        rewardFloorPrice = tickSize;
      }

      suggestedPrice = suggestedBidPrice(
        midpoint,
        spreadBand,
        rewardFloorPrice,
        tickSize,
        bestAsk
      );

      if (suggestedPrice === null) {
        status = "watchlist";
        reason = "unclear";
      } else {
        ownShares = quoteSizeUsdc / suggestedPrice;
        minimumQualifyingUsdc = row.rewardsMinSize * suggestedPrice;

        if (ownShares < row.rewardsMinSize) {
          reason = "quote_too_small_for_min_shares";
        } else {
          queueShares = queueAheadShares(bids, suggestedPrice);
          queueNotional = queueAheadNotional(bids, suggestedPrice);
          queueMultiple = ownShares > 0 ? queueShares / ownShares : null;
          depthShares = qualifyingDepthShares(bids, rewardFloorPrice, midpoint);
          distanceToAsk = bestAsk - suggestedPrice;

          if (spreadRatio !== null && spreadRatio > 1) {
            status = "watchlist";
            reason = "spread_too_large";
          } else if (
            queueMultiple !== null &&
            queueMultiple < meta.minQueueMultiple
          ) {
            status = "watchlist";
            reason = "queue_too_thin";
          } else if (
            meta.competitivenessP90 !== null &&
            row.marketCompetitiveness !== null &&
            row.marketCompetitiveness >= meta.competitivenessP90
          ) {
            status = "watchlist";
            reason = "too_crowded";
          } else {
            const ourScore = scoreWeight(spreadBand, midpoint - suggestedPrice);
            const bookVisibleWeight = visibleWeight(
              bids,
              midpoint,
              spreadBand,
              rewardFloorPrice
            );
            const ourWeight =
              ownShares !== null && ourScore !== null ? ownShares * ourScore : null;
            const denominator =
              ourWeight === null ? null : ourWeight + bookVisibleWeight;

            if (ourWeight === null || denominator === null || denominator <= 0) {
              status = "watchlist";
              reason = "unclear";
            } else {
              aprCeiling = row.rewardDailyRate * 36500 / quoteSizeUsdc;
              rawApr =
                row.rewardDailyRate * (ourWeight / denominator) * 36500 / quoteSizeUsdc;
              effectiveAprValue =
                pricingZone === null ? null : effectiveApr(rawApr, pricingZone, mode);
              status = "candidate_now";
              reason = "in_band";
            }
          }
        }
      }
    }
  }

  const bounds = scaleBounds([
    bestBid,
    bestAsk,
    midpoint,
    rewardFloorPrice,
    suggestedPrice
  ]);

  return {
    fetchedAt,
    snapshotGeneratedAt: meta.generatedAt,
    quoteSizeUsdc,
    mode,
    bestBid,
    bestAsk,
    adjustedMidpoint: midpoint,
    rewardsMaxSpread: row.rewardsMaxSpread,
    rewardsMinSize: row.rewardsMinSize,
    rewardFloorPrice,
    inBandUpperPrice: midpoint,
    suggestedPrice,
    ownShares,
    minimumQualifyingUsdc,
    queueAheadShares: queueShares,
    queueAheadNotional: queueNotional,
    queueMultiple,
    qualifyingDepthShares: depthShares,
    aprCeiling,
    rawApr,
    effectiveApr: effectiveAprValue,
    spreadRatio,
    distanceToAsk,
    pricingZone,
    status,
    reason,
    depth: {
      bids: compactDepth(bids, rewardFloorPrice, midpoint, suggestedPrice),
      scaleMin: bounds.scaleMin,
      scaleMax: bounds.scaleMax
    }
  };
}
