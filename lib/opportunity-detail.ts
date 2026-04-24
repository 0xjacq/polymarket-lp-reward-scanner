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
  role: "queue_ahead" | "below_order" | "outside_band";
  note: string;
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
  estimatedRewardPerDay: number | null;
  estimatedRewardUntilEnd: number | null;
  rewardStartDate: string | null;
  rewardEndDate: string | null;
  rewardDaysRemaining: number | null;
  eventEndTime: string | null;
  spreadRatio: number | null;
  distanceToAsk: number | null;
  pricingZone: DetailPricingZone | null;
  status: string;
  reason: string;
  recommendation: OpportunityRecommendation;
  depth: {
    bids: OpportunityDetailDepthLevel[];
    scaleMin: number;
    scaleMax: number;
  };
};

export type OpportunityRecommendation = {
  action: "place_bid" | "watchlist" | "do_not_place";
  title: string;
  reason: string;
  orderSide: string;
  limitPrice: number | null;
  shares: number | null;
  notional: number;
  estimatedApr: number | null;
  estimatedRewardPerDay: number | null;
  estimatedRewardUntilEnd: number | null;
  rewardBandLow: number | null;
  rewardBandHigh: number | null;
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
): OpportunityDetailDepthLevel[] {
  let cumulative = 0;
  const focused = bids
    .filter((level) => {
      if (rewardFloorPrice === null || adjustedMidpointPrice === null) {
        return true;
      }
      return (
        level.price >= rewardFloorPrice - 0.03 - EPSILON &&
        level.price <= adjustedMidpointPrice + 0.03 + EPSILON
      );
    })
    .slice(0, 12);
  const visible = focused.length > 0 ? focused : bids.slice(0, 8);

  return visible.map((level) => {
    cumulative += level.size;
    const inBand =
      rewardFloorPrice !== null &&
      adjustedMidpointPrice !== null &&
      level.price >= rewardFloorPrice - EPSILON &&
      level.price < adjustedMidpointPrice - EPSILON;
    const isQueueAhead =
      suggestedPrice !== null && level.price >= suggestedPrice - EPSILON;
    const role: OpportunityDetailDepthLevel["role"] = inBand
      ? isQueueAhead
        ? "queue_ahead"
        : "below_order"
      : "outside_band";
    return {
      price: level.price,
      size: level.size,
      cumulativeShares: cumulative,
      queueAheadShares:
        suggestedPrice === null || level.price + EPSILON < suggestedPrice
          ? 0
          : cumulative,
      inBand,
      isSuggested:
        suggestedPrice !== null && Math.abs(level.price - suggestedPrice) < EPSILON,
      role,
      note:
        role === "queue_ahead"
          ? "Ahead of your order"
          : role === "below_order"
            ? "Below your order"
            : "Outside reward band"
    };
  });
}

function daysRemaining(endDate: string | null) {
  if (!endDate) {
    return null;
  }
  const parts = endDate.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [year, month, day] = parts;
  const endExclusive = Date.UTC(year, month - 1, day + 1);
  const remainingMs = endExclusive - Date.now();
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / 86_400_000);
}

function formatCurrencyInput(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(value);
}

function recommendationReason(input: {
  status: string;
  reason: string;
  quoteSizeUsdc: number;
  queueMultiple: number | null;
  minQueueMultiple: number;
}) {
  const { status, reason, quoteSizeUsdc, queueMultiple, minQueueMultiple } = input;
  if (status === "candidate_now") {
    return "Inside the reward band with enough queue ahead at the current book.";
  }
  if (reason === "queue_too_thin") {
    return `Queue is too thin for $${formatCurrencyInput(quoteSizeUsdc)}: ${queueMultiple?.toFixed(2) ?? "0.00"}x visible versus ${minQueueMultiple.toFixed(2)}x required.`;
  }
  if (reason === "spread_too_large") {
    return "The market spread is currently wider than the reward band.";
  }
  if (reason === "quote_too_small_for_min_shares") {
    return "This quote size is too small to meet the minimum rewarded shares.";
  }
  if (reason === "reward_rules_unavailable") {
    return "Reward rules are unavailable for this row, so the app cannot compute a rewarded order.";
  }
  return "Current live book does not produce a clean rewarded order.";
}

function recommendationTitle(status: string) {
  if (status === "candidate_now") {
    return "Place bid";
  }
  if (status === "watchlist") {
    return "Watchlist";
  }
  return "Do not place";
}

function recommendationAction(
  status: string
): OpportunityRecommendation["action"] {
  if (status === "candidate_now") {
    return "place_bid";
  }
  if (status === "watchlist") {
    return "watchlist";
  }
  return "do_not_place";
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
  const hasRewardRules = row.rewardsMaxSpread > 0 && row.rewardsMinSize > 0;
  const midpoint = hasRewardRules
    ? adjustedMidpoint(bids, asks, row.rewardsMinSize)
    : null;
  const currentSpread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const spreadRatio =
    currentSpread !== null && spreadBand > 0 ? currentSpread / spreadBand : null;
  const pricingZone = midpoint === null ? null : toPricingZone(midpoint);
  const rewardDaysRemaining = daysRemaining(row.rewardEndDate);

  let status = "skip";
  let reason = hasRewardRules ? "missing_book_data" : "reward_rules_unavailable";
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

  if (hasRewardRules && midpoint !== null && bestAsk !== null) {
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

  const estimatedApr = mode === "two" ? rawApr : effectiveAprValue;
  const estimatedRewardPerDay =
    estimatedApr !== null ? (quoteSizeUsdc * estimatedApr) / 36500 : null;
  const estimatedRewardUntilEnd =
    estimatedRewardPerDay !== null && rewardDaysRemaining !== null
      ? estimatedRewardPerDay * rewardDaysRemaining
      : null;
  const recommendation: OpportunityRecommendation = {
    action: recommendationAction(status),
    title: recommendationTitle(status),
    reason: recommendationReason({
      status,
      reason,
      quoteSizeUsdc,
      queueMultiple,
      minQueueMultiple: meta.minQueueMultiple
    }),
    orderSide: row.sideToTrade,
    limitPrice: suggestedPrice,
    shares: ownShares,
    notional: quoteSizeUsdc,
    estimatedApr,
    estimatedRewardPerDay,
    estimatedRewardUntilEnd,
    rewardBandLow: rewardFloorPrice,
    rewardBandHigh: midpoint
  };

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
    estimatedRewardPerDay,
    estimatedRewardUntilEnd,
    rewardStartDate: row.rewardStartDate,
    rewardEndDate: row.rewardEndDate,
    rewardDaysRemaining,
    eventEndTime: row.eventEndTime,
    spreadRatio,
    distanceToAsk,
    pricingZone,
    status,
    reason,
    recommendation,
    depth: {
      bids: compactDepth(bids, rewardFloorPrice, midpoint, suggestedPrice),
      scaleMin: bounds.scaleMin,
      scaleMax: bounds.scaleMax
    }
  };
}
