import { NextRequest } from "next/server";

import {
  computeOpportunityDetail,
  fetchLiveBook,
  type DetailMode
} from "@/lib/opportunity-detail";
import { formatSnapshotError, getSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

function parseQuoteSize(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: NextRequest) {
  const marketId = request.nextUrl.searchParams.get("marketId");
  const tokenId = request.nextUrl.searchParams.get("tokenId");
  const modeParam = request.nextUrl.searchParams.get("mode");
  const mode: DetailMode = modeParam === "two" ? "two" : "single";

  if (!marketId || !tokenId) {
    return Response.json(
      { error: "marketId and tokenId are required." },
      { status: 400 }
    );
  }

  try {
    const snapshot = await getSnapshot();
    const dataset =
      mode === "two"
        ? snapshot.opportunities.twoSided.rows
        : snapshot.opportunities.singleSided.rows;
    const row = dataset.find(
      (candidate) =>
        candidate.marketId === marketId && candidate.tokenId === tokenId
    );

    if (!row) {
      return Response.json(
        { error: "Opportunity not found in the current snapshot." },
        { status: 404 }
      );
    }

    const quoteSizeUsdc = parseQuoteSize(
      request.nextUrl.searchParams.get("quoteSizeUsdc"),
      snapshot.meta.quoteSizeUsdc
    );
    const liveBook = await fetchLiveBook(tokenId);
    const payload = computeOpportunityDetail({
      row,
      meta: snapshot.meta,
      mode,
      quoteSizeUsdc,
      bids: liveBook.bids,
      asks: liveBook.asks,
      tickSize: liveBook.tickSize,
      fetchedAt: liveBook.fetchedAt
    });

    return Response.json(payload);
  } catch (error) {
    const message = formatSnapshotError(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
