import type { OpportunityRow, SnapshotMeta } from "@/lib/snapshot";
import {
  deriveLiveAvailability,
  type OpportunityLiveAvailability
} from "@/lib/live-availability";
import {
  buildAskDepth,
  buildBidDepth,
  type BookLevel
} from "@/lib/orderbook-utils";

const CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const CLOB_PRICE_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const SINGLE_SIDED_PENALTY = 3;
const APR_LOWER_BAND_FRACTION = 0.10;
const APR_UPPER_BAND_FRACTION = 0.45;
const EPSILON = 1e-9;

export type DetailPricingZone = "neutral" | "extreme";
export type PriceHistoryInterval = "1m" | "1h" | "6h" | "1d" | "1w" | "max";

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

type PriceHistoryResponse = {
  history?: Array<{
    t?: unknown;
    p?: unknown;
  }>;
};

export type OpportunityDetailDepthLevel = {
  price: number;
  size: number;
  cumulativeShares: number;
  cumulativeNotional: number;
  queueAheadShares: number;
  inBand: boolean;
  inRewardBand: boolean;
  isSuggested: boolean;
};

export type OpportunityDetailPricePoint = {
  t: number;
  p: number;
};

export type OpportunityDetailPayload = {
  fetchedAt: string;
  snapshotGeneratedAt: string;
  quoteSizeUsdc: number;
  liveAvailability: OpportunityLiveAvailability;
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
  aprLower: number | null;
  aprUpper: number | null;
  twoSidedApr: number | null;
  spreadRatio: number | null;
  distanceToAsk: number | null;
  pricingZone: DetailPricingZone | null;
  status: string;
  reason: string;
  rewardBand: {
    bidLower: number | null;
    midpoint: number | null;
    askUpper: number | null;
    maxSpread: number;
  };
  priceHistory: OpportunityDetailPricePoint[];
  depth: {
    asks: OpportunityDetailDepthLevel[];
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

function floorToTick(value: number, tickSize: number) {
  if (!(tickSize > 0)) {
    return value;
  }

  return roundToTick(Math.floor((value + EPSILON) / tickSize) * tickSize, tickSize);
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
    (scoreWeight(spreadBand, midpoint - candidate) ?? 0) <= EPSILON
  ) {
    candidate = roundToTick(candidate + tickSize, tickSize);
  }

  const score = scoreWeight(spreadBand, midpoint - candidate);
  if (score === null || score <= 0 || candidate >= bestAsk - EPSILON) {
    return null;
  }

  return candidate;
}

function effectiveApr(rawApr: number, pricingZone: DetailPricingZone, side: "single" | "two") {
  if (side === "two") {
    return rawApr;
  }
  return pricingZone === "neutral" ? rawApr / SINGLE_SIDED_PENALTY : 0;
}

function priceAtBandFraction(
  rewardFloorPrice: number,
  spreadBand: number,
  fraction: number,
  tickSize: number,
  bestAsk: number,
) {
  const price = ceilToTick(rewardFloorPrice + spreadBand * fraction, tickSize);
  if (price >= bestAsk - EPSILON) {
    return null;
  }
  return price;
}

function aprAtPrice(
  inputs: {
    row: OpportunityRow;
    midpoint: number;
    spreadBand: number;
    rewardFloor: number;
    pricingZone: DetailPricingZone;
    quoteSizeUsdc: number;
    bids: BookLevel[];
  },
  quotePrice: number,
) {
  const { row, midpoint, spreadBand, rewardFloor, pricingZone, quoteSizeUsdc, bids } = inputs;
  const ownShares = quoteSizeUsdc / quotePrice;
  if (ownShares < row.rewardsMinSize) {
    return null;
  }

  const distance = midpoint - quotePrice;
  const ourScore = scoreWeight(spreadBand, distance);
  if (ourScore === null) {
    return null;
  }

  const ourWeight = ourScore * ownShares;
  const bookVisibleWeight = visibleWeight(bids, midpoint, spreadBand, rewardFloor);
  const denominator = ourWeight + bookVisibleWeight;
  if (denominator <= 0) {
    return null;
  }

  const rawApr = row.rewardDailyRate * (ourWeight / denominator) * 36500 / quoteSizeUsdc;
  return effectiveApr(rawApr, pricingZone, "single");
}

function toPricingZone(midpoint: number): DetailPricingZone {
  return midpoint >= 0.1 && midpoint <= 0.9 ? "neutral" : "extreme";
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
  if (response.status === 404) {
    return {
      bids: [],
      asks: [],
      tickSize: 0.01,
      fetchedAt: new Date().toISOString()
    };
  }

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

const PRICE_HISTORY_INTERVALS = new Set<PriceHistoryInterval>([
  "1m",
  "1h",
  "6h",
  "1d",
  "1w",
  "max"
]);

export function parsePriceHistoryInterval(value: string | null) {
  return value && PRICE_HISTORY_INTERVALS.has(value as PriceHistoryInterval)
    ? (value as PriceHistoryInterval)
    : "6h";
}

function fidelityForInterval(interval: PriceHistoryInterval) {
  switch (interval) {
    case "1m":
      return "1";
    case "1h":
      return "1";
    case "1d":
      return "15";
    case "1w":
      return "60";
    case "max":
      return "240";
    case "6h":
    default:
      return "5";
  }
}

export async function fetchPriceHistory(
  tokenId: string,
  interval: PriceHistoryInterval = "6h"
) {
  const url = new URL(CLOB_PRICE_HISTORY_URL);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("interval", interval);
  url.searchParams.set("fidelity", fidelityForInterval(interval));

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Price history fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as PriceHistoryResponse;
  if (!Array.isArray(payload.history)) {
    return [];
  }

  return payload.history
    .map((point) => {
      const t = toNumber(point.t);
      const p = toNumber(point.p);
      if (t === null || p === null || p < 0 || p > 1) {
        return null;
      }
      return { t, p };
    })
    .filter((point): point is OpportunityDetailPricePoint => point !== null)
    .sort((left, right) => left.t - right.t);
}

export function computeOpportunityDetail(input: {
  row: OpportunityRow;
  meta: SnapshotMeta;
  quoteSizeUsdc: number;
  bids: BookLevel[];
  asks: BookLevel[];
  priceHistory: OpportunityDetailPricePoint[];
  tickSize: number;
  fetchedAt: string;
}): OpportunityDetailPayload {
  const {
    row,
    meta,
    quoteSizeUsdc,
    bids,
    asks,
    priceHistory,
    tickSize,
    fetchedAt
  } = input;
  const spreadBand = row.rewardsMaxSpread / 100;
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midpoint = adjustedMidpoint(bids, asks, row.rewardsMinSize);
  const liveAvailability = deriveLiveAvailability({
    bids,
    asks,
    priceHistory,
    rewardsMinSize: row.rewardsMinSize
  });
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
  let twoSidedAprValue: number | null = null;
  let askUpperPrice: number | null = null;
  let aprLower: number | null = null;
  let aprUpper: number | null = null;
  let suggestedPriceLower: number | null = null;
  let suggestedPriceUpper: number | null = null;

  if (liveAvailability.canRecomputeLiveMetrics && midpoint !== null && bestAsk !== null) {
    status = "skip";
    reason = "missing_book_data";

    {
      rewardFloorPrice = ceilToTick(midpoint - spreadBand, tickSize);
      if (rewardFloorPrice < tickSize) {
        rewardFloorPrice = tickSize;
      }
      askUpperPrice = floorToTick(midpoint + spreadBand, tickSize);
      if (askUpperPrice > 1) {
        askUpperPrice = 1;
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
                pricingZone === null ? null : effectiveApr(rawApr, pricingZone, "single");
              twoSidedAprValue =
                pricingZone === null ? null : effectiveApr(rawApr, pricingZone, "two");
              status = "candidate_now";
              reason = "in_band";

              const aprInputs = {
                row,
                midpoint,
                spreadBand,
                rewardFloor: rewardFloorPrice,
                pricingZone: pricingZone!,
                quoteSizeUsdc,
                bids,
              };
              suggestedPriceLower = priceAtBandFraction(
                rewardFloorPrice, spreadBand, APR_LOWER_BAND_FRACTION, tickSize, bestAsk
              );
              aprLower = suggestedPriceLower === null ? null
                : aprAtPrice(aprInputs, suggestedPriceLower);
              suggestedPriceUpper = priceAtBandFraction(
                rewardFloorPrice, spreadBand, APR_UPPER_BAND_FRACTION, tickSize, bestAsk
              );
              aprUpper = suggestedPriceUpper === null ? null
                : aprAtPrice(aprInputs, suggestedPriceUpper);
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
    askUpperPrice,
    suggestedPrice,
    ...priceHistory.map((point) => point.p)
  ]);

  return {
    fetchedAt,
    snapshotGeneratedAt: meta.generatedAt,
    quoteSizeUsdc,
    liveAvailability,
    bestBid,
    bestAsk,
    adjustedMidpoint: midpoint,
    rewardsMaxSpread: row.rewardsMaxSpread,
    rewardsMinSize: row.rewardsMinSize,
    rewardFloorPrice,
    inBandUpperPrice: askUpperPrice,
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
    aprLower,
    aprUpper,
    twoSidedApr: twoSidedAprValue,
    spreadRatio,
    distanceToAsk,
    pricingZone,
    status,
    reason,
    rewardBand: {
      bidLower: rewardFloorPrice,
      midpoint,
      askUpper: askUpperPrice,
      maxSpread: spreadBand
    },
    priceHistory,
    depth: {
      asks: buildAskDepth(asks, midpoint, askUpperPrice),
      bids: buildBidDepth(bids, rewardFloorPrice, midpoint, suggestedPrice),
      scaleMin: bounds.scaleMin,
      scaleMax: bounds.scaleMax
    }
  };
}
