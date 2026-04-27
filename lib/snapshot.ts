import { readFile } from "node:fs/promises";

import { head } from "@vercel/blob";

const DEFAULT_BLOB_PATH = "scanner/latest.json";
const SNAPSHOT_CADENCE_MS = 5 * 60 * 1000;
const SNAPSHOT_STALE_AFTER_MS = SNAPSHOT_CADENCE_MS * 3;

type JsonRecord = Record<string, unknown>;

export type EventTiming = "started" | "upcoming";
export type SnapshotSource = "local_file" | "public_url" | "blob";
export type SnapshotHealth = "fresh" | "stale";

export type SnapshotMeta = {
  generatedAt: string;
  scanDurationMs: number;
  sourceVersion: string;
  quoteSizeUsdc: number;
  minQueueMultiple: number;
  competitivenessP90: number | null;
  snapshotSource: SnapshotSource;
  snapshotHealth: SnapshotHealth;
  snapshotAgeMs: number;
  staleAfterMs: number;
  warning: string | null;
};

export type DashboardRow = {
  marketId: string;
  question: string;
  marketUrl: string | null;
  image: string | null;
  tags: string[];
  eventStartTime: string | null;
  eventTiming: EventTiming;
  timeToStartHuman: string | null;
  rewardDailyRate: number;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  marketCompetitiveness: number | null;
};

export type OpportunityRow = {
  marketId: string;
  question: string;
  marketUrl: string | null;
  image: string | null;
  tags: string[];
  sideToTrade: string;
  tokenId: string;
  status: string;
  reason: string;
  eventStartTime: string | null;
  eventTiming: EventTiming;
  timeToStartHuman: string | null;
  rewardDailyRate: number;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  pricingZone: string | null;
  marketCompetitiveness: number | null;
  spreadRatio: number | null;
  aprCeiling: number | null;
  rawApr: number | null;
  effectiveApr: number | null;
  twoSidedApr: number | null;
  suggestedPrice: number | null;
  queueMultiple: number | null;
};

export type DashboardResponse = {
  meta: SnapshotMeta;
  availableTags: string[];
  rows: DashboardRow[];
};

export type ScannerResponse = {
  meta: SnapshotMeta;
  availableTags: string[];
  neutral: { rows: OpportunityRow[] };
  extreme: { rows: OpportunityRow[] };
};

type SnapshotPayload = {
  meta: SnapshotMeta;
  availableTags: string[];
  dashboard: { rows: DashboardRow[] };
  opportunities: {
    neutral: { rows: OpportunityRow[] };
    extreme: { rows: OpportunityRow[] };
  };
};

let cachedSnapshot: SnapshotPayload | null = null;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeEventTiming(value: unknown): EventTiming {
  return value === "started" ? "started" : "upcoming";
}

function normalizeMeta(value: unknown, source: SnapshotSource): SnapshotMeta {
  const input = asRecord(value);
  return snapshotMetaWithFreshness(
    {
      generatedAt: toStringValue(input.generatedAt) ?? new Date(0).toISOString(),
      scanDurationMs: toNumber(input.scanDurationMs) ?? 0,
      sourceVersion: toStringValue(input.sourceVersion) ?? "unknown",
      quoteSizeUsdc: toNumber(input.quoteSizeUsdc) ?? 1000,
      minQueueMultiple: toNumber(input.minQueueMultiple) ?? 2,
      competitivenessP90: toNumber(input.competitivenessP90),
      snapshotSource: source,
      snapshotHealth: "fresh",
      snapshotAgeMs: 0,
      staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
      warning: null
    },
    source,
    null
  );
}

function normalizeDashboardRow(value: unknown): DashboardRow {
  const input = asRecord(value);
  return {
    marketId: toStringValue(input.marketId) ?? "",
    question: toStringValue(input.question) ?? "Unknown market",
    marketUrl: toStringValue(input.marketUrl),
    image: toStringValue(input.image),
    tags: toStringArray(input.tags),
    eventStartTime: toStringValue(input.eventStartTime),
    eventTiming: normalizeEventTiming(input.eventTiming),
    timeToStartHuman: toStringValue(input.timeToStartHuman),
    rewardDailyRate: toNumber(input.rewardDailyRate) ?? 0,
    rewardsMaxSpread: toNumber(input.rewardsMaxSpread) ?? 0,
    rewardsMinSize: toNumber(input.rewardsMinSize) ?? 0,
    marketCompetitiveness: toNumber(input.marketCompetitiveness)
  };
}

function normalizeOpportunityRow(value: unknown): OpportunityRow {
  const input = asRecord(value);
  return {
    marketId: toStringValue(input.marketId) ?? "",
    question: toStringValue(input.question) ?? "Unknown market",
    marketUrl: toStringValue(input.marketUrl),
    image: toStringValue(input.image),
    tags: toStringArray(input.tags),
    sideToTrade: toStringValue(input.sideToTrade) ?? "-",
    tokenId: toStringValue(input.tokenId) ?? "",
    status: toStringValue(input.status) ?? "unknown",
    reason: toStringValue(input.reason) ?? "unknown",
    eventStartTime: toStringValue(input.eventStartTime),
    eventTiming: normalizeEventTiming(input.eventTiming),
    timeToStartHuman: toStringValue(input.timeToStartHuman),
    rewardDailyRate: toNumber(input.rewardDailyRate) ?? 0,
    rewardsMaxSpread: toNumber(input.rewardsMaxSpread) ?? 0,
    rewardsMinSize: toNumber(input.rewardsMinSize) ?? 0,
    pricingZone: toStringValue(input.pricingZone),
    marketCompetitiveness: toNumber(input.marketCompetitiveness),
    spreadRatio: toNumber(input.spreadRatio),
    aprCeiling: toNumber(input.aprCeiling),
    rawApr: toNumber(input.rawApr),
    effectiveApr: toNumber(input.effectiveApr),
    twoSidedApr: toNumber(input.twoSidedApr),
    suggestedPrice: toNumber(input.suggestedPrice),
    queueMultiple: toNumber(input.queueMultiple)
  };
}

function normalizeSnapshot(raw: unknown, source: SnapshotSource): SnapshotPayload {
  const input = asRecord(raw);
  const dashboard = asRecord(input.dashboard);
  const opportunities = asRecord(input.opportunities);

  // Backwards-compat: accept the old singleSided/twoSided keys until the new
  // Rust snapshot format (neutral/extreme) is published by GitHub Actions.
  const rawNeutral = asRecord(opportunities.neutral ?? opportunities.singleSided);
  const rawExtreme = asRecord(opportunities.extreme ?? opportunities.twoSided);

  return {
    meta: normalizeMeta(input.meta, source),
    availableTags: toStringArray(input.availableTags),
    dashboard: {
      rows: Array.isArray(dashboard.rows)
        ? dashboard.rows.map(normalizeDashboardRow)
        : []
    },
    opportunities: {
      neutral: {
        rows: Array.isArray(rawNeutral.rows)
          ? rawNeutral.rows.map(normalizeOpportunityRow)
          : []
      },
      extreme: {
        rows: Array.isArray(rawExtreme.rows)
          ? rawExtreme.rows.map(normalizeOpportunityRow)
          : []
      }
    }
  };
}

async function readSnapshotText(): Promise<{ text: string; source: SnapshotSource }> {
  const localPath = process.env.SNAPSHOT_LOCAL_PATH;
  if (localPath) {
    return {
      text: await readFile(localPath, "utf8"),
      source: "local_file"
    };
  }

  const publicUrl = process.env.SNAPSHOT_PUBLIC_URL;
  if (publicUrl) {
    const response = await fetch(publicUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Snapshot fetch failed with status ${response.status}`);
    }
    return {
      text: await response.text(),
      source: "public_url"
    };
  }

  const blobPath = process.env.SNAPSHOT_BLOB_PATH ?? DEFAULT_BLOB_PATH;
  const metadata = await head(blobPath, {
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  const response = await fetch(metadata.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Snapshot blob fetch failed with status ${response.status}`);
  }
  return {
    text: await response.text(),
    source: "blob"
  };
}

export async function getSnapshot(): Promise<SnapshotPayload> {
  try {
    const { text, source } = await readSnapshotText();
    const snapshot = normalizeSnapshot(JSON.parse(text) as unknown, source);
    cachedSnapshot = snapshot;
    return snapshot;
  } catch (error) {
    if (cachedSnapshot) {
      return {
        ...cachedSnapshot,
        meta: snapshotMetaWithFreshness(
          cachedSnapshot.meta,
          cachedSnapshot.meta.snapshotSource,
          error instanceof Error
            ? `Serving last good snapshot after refresh failure: ${error.message}`
            : "Serving last good snapshot after refresh failure."
        )
      };
    }

    throw error;
  }
}

export function formatSnapshotError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Snapshot loading failed.";

  if (message.includes("No token found")) {
    return "Blob access is not configured locally. Set SNAPSHOT_PUBLIC_URL in .env.local for real snapshot data, set BLOB_READ_WRITE_TOKEN for direct Blob reads, or use npm run dev:mock-snapshot for the explicit local fixture.";
  }

  return message;
}

export async function getDashboardData(limit?: number): Promise<DashboardResponse> {
  const snapshot = await getSnapshot();
  return {
    meta: snapshot.meta,
    availableTags: snapshot.availableTags,
    rows:
      typeof limit === "number"
        ? snapshot.dashboard.rows.slice(0, limit)
        : snapshot.dashboard.rows
  };
}

export async function getScannerData(limit?: number): Promise<ScannerResponse> {
  const snapshot = await getSnapshot();
  const neutralRows =
    typeof limit === "number"
      ? snapshot.opportunities.neutral.rows.slice(0, limit)
      : snapshot.opportunities.neutral.rows;
  const extremeRows =
    typeof limit === "number"
      ? snapshot.opportunities.extreme.rows.slice(0, limit)
      : snapshot.opportunities.extreme.rows;

  return {
    meta: snapshot.meta,
    availableTags: snapshot.availableTags,
    neutral: { rows: neutralRows },
    extreme: { rows: extremeRows }
  };
}

export async function getPageData() {
  const snapshot = await getSnapshot();
  return {
    dashboard: {
      meta: snapshot.meta,
      availableTags: snapshot.availableTags,
      rows: snapshot.dashboard.rows
    } satisfies DashboardResponse,
    scanner: {
      meta: snapshot.meta,
      availableTags: snapshot.availableTags,
      neutral: snapshot.opportunities.neutral,
      extreme: snapshot.opportunities.extreme
    } satisfies ScannerResponse
  };
}
function snapshotMetaWithFreshness(meta: SnapshotMeta, source: SnapshotSource, warning: string | null) {
  const snapshotAgeMs = Math.max(0, Date.now() - new Date(meta.generatedAt).getTime());
  const snapshotHealth: SnapshotHealth =
    snapshotAgeMs > SNAPSHOT_STALE_AFTER_MS ? "stale" : "fresh";

  return {
    ...meta,
    snapshotSource: source,
    snapshotHealth,
    snapshotAgeMs,
    staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
    warning:
      warning ??
      (snapshotHealth === "stale"
        ? "Snapshot is older than the 5-minute publishing cadence."
        : null)
  };
}
