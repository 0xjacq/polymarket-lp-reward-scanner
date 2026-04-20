import { NextRequest } from "next/server";

import { formatSnapshotError, getScannerData } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 10), 250) : undefined;

  try {
    const payload = await getScannerData(safeLimit);
    return Response.json(payload);
  } catch (error) {
    const message = formatSnapshotError(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
