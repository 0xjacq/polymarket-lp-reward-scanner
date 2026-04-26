import type {
  OpportunityDetailDepthLevel,
  OpportunityDetailPayload
} from "@/lib/opportunity-detail";

const EPSILON = 1e-9;

export type BookSide = "bids" | "asks";

export type BookLevel = {
  price: number;
  size: number;
};

export function normalizeBookLevels(levels: BookLevel[], side: BookSide) {
  return [...levels]
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((left, right) =>
      side === "bids" ? right.price - left.price : left.price - right.price
    );
}

export function levelsFromDepth(depth: OpportunityDetailDepthLevel[]) {
  return depth.map((level) => ({ price: level.price, size: level.size }));
}

export function applyLevelChange(
  levels: BookLevel[],
  side: BookSide,
  price: number,
  size: number
) {
  const next = new Map(levels.map((level) => [level.price, level.size]));
  if (size <= 0) {
    next.delete(price);
  } else {
    next.set(price, size);
  }

  return normalizeBookLevels(
    Array.from(next.entries()).map(([levelPrice, levelSize]) => ({
      price: levelPrice,
      size: levelSize
    })),
    side
  );
}

export function buildBidDepth(
  levels: BookLevel[],
  rewardFloorPrice: number | null,
  midpoint: number | null,
  suggestedPrice: number | null,
  limit = 20
) {
  let cumulative = 0;
  let cumulativeNotional = 0;
  return normalizeBookLevels(levels, "bids").slice(0, limit).map((level) => {
    cumulative += level.size;
    cumulativeNotional += level.size * level.price;
    const inRewardBand =
      rewardFloorPrice !== null &&
      midpoint !== null &&
      level.price >= rewardFloorPrice - EPSILON &&
      level.price < midpoint - EPSILON;

    return {
      price: level.price,
      size: level.size,
      cumulativeShares: cumulative,
      cumulativeNotional,
      queueAheadShares:
        suggestedPrice === null || level.price + EPSILON < suggestedPrice
          ? 0
          : cumulative,
      inBand: inRewardBand,
      inRewardBand,
      isSuggested:
        suggestedPrice !== null && Math.abs(level.price - suggestedPrice) < EPSILON
    };
  });
}

export function buildAskDepth(
  levels: BookLevel[],
  midpoint: number | null,
  askUpperPrice: number | null,
  limit = 20
) {
  let cumulative = 0;
  let cumulativeNotional = 0;
  return normalizeBookLevels(levels, "asks").slice(0, limit).map((level) => {
    cumulative += level.size;
    cumulativeNotional += level.size * level.price;
    const inRewardBand =
      midpoint !== null &&
      askUpperPrice !== null &&
      level.price >= midpoint - EPSILON &&
      level.price <= askUpperPrice + EPSILON;

    return {
      price: level.price,
      size: level.size,
      cumulativeShares: cumulative,
      cumulativeNotional,
      queueAheadShares: 0,
      inBand: inRewardBand,
      inRewardBand,
      isSuggested: false
    };
  });
}

export function deriveLiveDetail(
  detail: OpportunityDetailPayload,
  bids: BookLevel[],
  asks: BookLevel[],
  fetchedAt = new Date().toISOString()
) {
  const normalizedBids = normalizeBookLevels(bids, "bids");
  const normalizedAsks = normalizeBookLevels(asks, "asks");
  const bestBid = normalizedBids[0]?.price ?? null;
  const bestAsk = normalizedAsks[0]?.price ?? null;
  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const maxSpread = detail.rewardBand.maxSpread;
  const bidDepth = buildBidDepth(
    normalizedBids,
    detail.rewardBand.bidLower,
    detail.rewardBand.midpoint,
    detail.suggestedPrice
  );
  const askDepth = buildAskDepth(
    normalizedAsks,
    detail.rewardBand.midpoint,
    detail.rewardBand.askUpper
  );
  const queueAheadLevel =
    detail.suggestedPrice === null
      ? null
      : bidDepth.find(
          (level) => Math.abs(level.price - detail.suggestedPrice!) < EPSILON
        ) ?? null;
  const queueAheadShares =
    detail.suggestedPrice === null
      ? detail.queueAheadShares
      : normalizedBids
          .filter((level) => level.price >= detail.suggestedPrice! - EPSILON)
          .reduce((acc, level) => acc + level.size, 0);
  const queueAheadNotional =
    detail.suggestedPrice === null
      ? detail.queueAheadNotional
      : normalizedBids
          .filter((level) => level.price >= detail.suggestedPrice! - EPSILON)
          .reduce((acc, level) => acc + level.size * level.price, 0);
  const qualifyingDepthShares =
    detail.rewardBand.bidLower === null || detail.rewardBand.midpoint === null
      ? detail.qualifyingDepthShares
      : normalizedBids
          .filter(
            (level) =>
              level.price >= detail.rewardBand.bidLower! - EPSILON &&
              level.price < detail.rewardBand.midpoint! - EPSILON
          )
          .reduce((acc, level) => acc + level.size, 0);

  return {
    ...detail,
    fetchedAt,
    bestBid,
    bestAsk,
    spreadRatio:
      spread !== null && maxSpread > 0 ? spread / maxSpread : detail.spreadRatio,
    distanceToAsk:
      bestAsk !== null && detail.suggestedPrice !== null
        ? bestAsk - detail.suggestedPrice
        : detail.distanceToAsk,
    queueAheadShares,
    queueAheadNotional,
    queueMultiple:
      detail.ownShares !== null && queueAheadShares !== null && detail.ownShares > 0
        ? queueAheadShares / detail.ownShares
        : detail.queueMultiple,
    qualifyingDepthShares,
    depth: {
      ...detail.depth,
      asks: askDepth,
      bids: bidDepth
    }
  };
}
