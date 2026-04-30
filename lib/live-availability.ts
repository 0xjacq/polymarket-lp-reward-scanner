type LiveBookLevel = {
  price: number;
  size: number;
};

export type OpportunityLiveFallbackReason =
  | "missing_bid_side"
  | "missing_ask_side"
  | "missing_orderbook"
  | "incomplete_live_inputs";

export type OpportunityLiveAvailability = {
  hasBids: boolean;
  hasAsks: boolean;
  hasPriceHistory: boolean;
  hasCompleteBook: boolean;
  canRecomputeLiveMetrics: boolean;
  fallbackReason: OpportunityLiveFallbackReason | null;
};

function priceAtCumulativeDepth(levels: LiveBookLevel[], threshold: number) {
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
  bids: LiveBookLevel[],
  asks: LiveBookLevel[],
  rewardsMinSize: number
) {
  const bidPrice = priceAtCumulativeDepth(bids, rewardsMinSize) ?? bids[0]?.price ?? null;
  const askPrice = priceAtCumulativeDepth(asks, rewardsMinSize) ?? asks[0]?.price ?? null;
  if (bidPrice === null || askPrice === null) {
    return null;
  }
  return (bidPrice + askPrice) / 2;
}

export function deriveLiveAvailability(input: {
  bids: LiveBookLevel[];
  asks: LiveBookLevel[];
  priceHistory: ArrayLike<unknown>;
  rewardsMinSize: number;
}): OpportunityLiveAvailability {
  const { bids, asks, priceHistory, rewardsMinSize } = input;
  const hasBids = bids.length > 0;
  const hasAsks = asks.length > 0;
  const hasPriceHistory = priceHistory.length > 0;
  const hasCompleteBook = hasBids && hasAsks;
  const midpoint = adjustedMidpoint(bids, asks, rewardsMinSize);
  const bestAsk = asks[0]?.price ?? null;
  const canRecomputeLiveMetrics =
    hasCompleteBook && midpoint !== null && bestAsk !== null;

  let fallbackReason: OpportunityLiveFallbackReason | null = null;
  if (!canRecomputeLiveMetrics) {
    if (hasBids && !hasAsks) {
      fallbackReason = "missing_ask_side";
    } else if (!hasBids && hasAsks) {
      fallbackReason = "missing_bid_side";
    } else if (!hasBids && !hasAsks) {
      fallbackReason = "missing_orderbook";
    } else {
      fallbackReason = "incomplete_live_inputs";
    }
  }

  return {
    hasBids,
    hasAsks,
    hasPriceHistory,
    hasCompleteBook,
    canRecomputeLiveMetrics,
    fallbackReason
  };
}
