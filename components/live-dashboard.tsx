"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  DetailMode,
  OpportunityDetailPayload
} from "@/lib/opportunity-detail";
import type {
  EventTiming,
  OpportunityRow,
  ScannerResponse
} from "@/lib/snapshot";

type Props = {
  initialScanner: ScannerResponse | null;
  initialError?: string | null;
};

type TimingFilter = EventTiming | "all";
type ScannerSort =
  | "effectiveApr"
  | "rawApr"
  | "rewardDailyRate"
  | "soonest"
  | "queueMultiple"
  | "spreadRatio";

type DetailState = {
  key: string | null;
  loading: boolean;
  error: string | null;
  data: OpportunityDetailPayload | null;
};

const REFRESH_MS = 30_000;
const COUNTDOWN_TICK_MS = 30_000;
const DETAIL_DEBOUNCE_MS = 300;

function formatNumber(value: number | null, fractionDigits = 0) {
  if (value === null) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits
  }).format(value);
}

function formatMoney(value: number | null, fractionDigits = 2) {
  if (value === null) {
    return "-";
  }

  return `$${formatNumber(value, fractionDigits)}`;
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `${formatNumber(value, 2)}%`;
}

function formatMultiple(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `${formatNumber(value, 2)}x`;
}

function formatPrice(value: number | null) {
  if (value === null) {
    return "-";
  }

  return formatNumber(value, 3);
}

function formatShares(value: number | null) {
  if (value === null) {
    return "-";
  }

  return formatNumber(value, 0);
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
}

function formatDurationFromMs(value: number | null) {
  if (value === null) {
    return "-";
  }

  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function humanize(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareNullableDesc(left: number | null, right: number | null) {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return rightValue - leftValue;
}

function compareNullableAsc(left: number | null, right: number | null) {
  const leftValue = left ?? Number.POSITIVE_INFINITY;
  const rightValue = right ?? Number.POSITIVE_INFINITY;
  return leftValue - rightValue;
}

function matchesTiming(rowTiming: EventTiming, filter: TimingFilter) {
  return filter === "all" || rowTiming === filter;
}

function matchesSearch(query: string, values: string[]) {
  if (!query) {
    return true;
  }

  return values.some((value) => value.toLowerCase().includes(query));
}

function parsePositiveNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rowKey(row: OpportunityRow, mode: DetailMode) {
  return `${mode}:${row.marketId}:${row.tokenId}`;
}

function formatLiveTimeToStart(
  eventStartTime: string | null,
  fallback: string | null,
  nowMs: number | null
) {
  if (!eventStartTime || nowMs === null) {
    return fallback ?? "-";
  }

  return formatDurationFromMs(
    Math.max(0, new Date(eventStartTime).getTime() - nowMs)
  );
}

function FilterToggle({
  label,
  value,
  active,
  onClick
}: {
  label: string;
  value: string;
  active: boolean;
  onClick: (value: string) => void;
}) {
  return (
    <button
      className={active ? "toggle-chip active" : "toggle-chip"}
      onClick={() => onClick(value)}
      type="button"
    >
      {label}
    </button>
  );
}

function MetricCell({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function markerPosition(
  value: number | null,
  scaleMin: number,
  scaleMax: number
) {
  if (value === null) {
    return null;
  }

  if (scaleMax - scaleMin <= 0) {
    return 50;
  }

  const position = ((value - scaleMin) / (scaleMax - scaleMin)) * 100;
  return Math.max(0, Math.min(100, position));
}

function BandVisualization({ detail }: { detail: OpportunityDetailPayload }) {
  const bandStart = markerPosition(
    detail.rewardFloorPrice,
    detail.depth.scaleMin,
    detail.depth.scaleMax
  );
  const bandEnd = markerPosition(
    detail.inBandUpperPrice,
    detail.depth.scaleMin,
    detail.depth.scaleMax
  );
  const markers = [
    {
      label: "Reward floor",
      value: detail.rewardFloorPrice,
      className: "marker-floor"
    },
    {
      label: "Suggested",
      value: detail.suggestedPrice,
      className: "marker-suggested"
    },
    {
      label: "Best bid",
      value: detail.bestBid,
      className: "marker-bid"
    },
    {
      label: "Midpoint",
      value: detail.adjustedMidpoint,
      className: "marker-midpoint"
    },
    {
      label: "Best ask",
      value: detail.bestAsk,
      className: "marker-ask"
    }
  ]
    .map((marker) => ({
      ...marker,
      position: markerPosition(
        marker.value,
        detail.depth.scaleMin,
        detail.depth.scaleMax
      )
    }))
    .filter(
      (
        marker
      ): marker is typeof marker & {
        position: number;
      } => marker.position !== null
    );

  return (
    <div className="lp-chart">
      <div className="lp-chart-track">
        {bandStart !== null && bandEnd !== null && bandEnd > bandStart ? (
          <div
            className="lp-band"
            style={{
              left: `${bandStart}%`,
              width: `${bandEnd - bandStart}%`
            }}
          />
        ) : null}

        {markers.map((marker) => (
          <div
            key={marker.label}
            className={`lp-marker ${marker.className}`}
            style={{ left: `${marker.position}%` }}
          >
            <span />
            <small>{marker.label}</small>
          </div>
        ))}
      </div>

      <div className="lp-scale">
        <span>{formatPrice(detail.depth.scaleMin)}</span>
        <span>{formatPrice(detail.depth.scaleMax)}</span>
      </div>
    </div>
  );
}

function DepthVisualization({ detail }: { detail: OpportunityDetailPayload }) {
  const maxSize = Math.max(
    1,
    ...detail.depth.bids.map((level) => level.size)
  );

  return (
    <div className="depth-table">
      {detail.depth.bids.length === 0 ? (
        <p className="detail-empty">No live bid depth was returned.</p>
      ) : (
        detail.depth.bids.map((level) => (
          <div
            key={`${level.price}-${level.cumulativeShares}`}
            className={
              level.isSuggested
                ? "depth-row is-suggested"
                : level.inBand
                  ? "depth-row is-in-band"
                  : "depth-row"
            }
          >
            <div className="depth-price">{formatPrice(level.price)}</div>
            <div className="depth-bar-shell">
              <div
                className="depth-bar"
                style={{ width: `${(level.size / maxSize) * 100}%` }}
              />
            </div>
            <div className="depth-size">{formatShares(level.size)}</div>
            <div className="depth-queue">
              {level.queueAheadShares > 0
                ? formatShares(level.queueAheadShares)
                : "-"}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function LPDetailsPanel({
  row,
  detail,
  error,
  loading,
  quoteSizeInput,
  onQuoteSizeChange,
  defaultQuoteSize
}: {
  row: OpportunityRow;
  detail: OpportunityDetailPayload | null;
  error: string | null;
  loading: boolean;
  quoteSizeInput: string;
  onQuoteSizeChange: (value: string) => void;
  defaultQuoteSize: number;
}) {
  return (
    <section className="lp-panel">
      <div className="lp-panel-toolbar">
        <label className="control lp-quote-control">
          <span>Quote size (USDC)</span>
          <input
            inputMode="decimal"
            value={quoteSizeInput}
            onChange={(event) => onQuoteSizeChange(event.target.value)}
            placeholder={String(defaultQuoteSize)}
          />
        </label>

        <div className="lp-panel-copy">
          <span>Side</span>
          <strong>{row.sideToTrade}</strong>
        </div>

        <div className="lp-panel-copy">
          <span>Live status</span>
          <strong>{loading ? "Refreshing live book..." : "Live book ready"}</strong>
        </div>
      </div>

      {error ? <p className="error-banner panel-banner">{error}</p> : null}

      {detail ? (
        <>
          <p className="panel-note">
            Live book fetched {formatTimestamp(detail.fetchedAt)}. Ranked snapshot was
            published {formatTimestamp(detail.snapshotGeneratedAt)}.
          </p>

          <BandVisualization detail={detail} />

          <div className="detail-sections">
            <section className="detail-card">
              <h3>Live book</h3>
              <div className="detail-grid">
                <MetricCell label="Best bid" value={formatPrice(detail.bestBid)} />
                <MetricCell label="Best ask" value={formatPrice(detail.bestAsk)} />
                <MetricCell
                  label="Adjusted midpoint"
                  value={formatPrice(detail.adjustedMidpoint)}
                />
                <MetricCell
                  label="Spread x"
                  value={formatMultiple(detail.spreadRatio)}
                />
              </div>
              <DepthVisualization detail={detail} />
            </section>

            <section className="detail-card">
              <h3>Reward rules</h3>
              <div className="detail-grid">
                <MetricCell
                  label="Reward / day"
                  value={formatMoney(row.rewardDailyRate)}
                />
                <MetricCell
                  label="Max spread"
                  value={`${formatNumber(detail.rewardsMaxSpread, 2)}c`}
                />
                <MetricCell
                  label="Min shares"
                  value={formatShares(detail.rewardsMinSize)}
                />
                <MetricCell
                  label="Eligible band"
                  value={
                    detail.rewardFloorPrice === null ||
                    detail.inBandUpperPrice === null
                      ? "-"
                      : `${formatPrice(detail.rewardFloorPrice)} to ${formatPrice(
                          detail.inBandUpperPrice
                        )}`
                  }
                />
              </div>
            </section>

            <section className="detail-card">
              <h3>Your quote</h3>
              <div className="detail-grid">
                <MetricCell
                  label="Suggested price"
                  value={formatPrice(detail.suggestedPrice)}
                />
                <MetricCell label="Your shares" value={formatShares(detail.ownShares)} />
                <MetricCell
                  label="Min qualifying quote"
                  value={formatMoney(detail.minimumQualifyingUsdc)}
                />
                <MetricCell
                  label="Distance to ask"
                  value={formatPrice(detail.distanceToAsk)}
                />
                <MetricCell
                  label="Queue ahead"
                  value={formatShares(detail.queueAheadShares)}
                />
                <MetricCell
                  label="Queue ahead notional"
                  value={formatMoney(detail.queueAheadNotional)}
                />
                <MetricCell
                  label="Queue x"
                  value={formatMultiple(detail.queueMultiple)}
                />
                <MetricCell
                  label="Qualifying depth"
                  value={formatShares(detail.qualifyingDepthShares)}
                />
              </div>
            </section>

            <section className="detail-card">
              <h3>Estimated rewards</h3>
              <div className="detail-grid">
                <MetricCell
                  label="APR ceiling"
                  value={formatPercent(detail.aprCeiling)}
                />
                <MetricCell label="Raw APR" value={formatPercent(detail.rawApr)} />
                <MetricCell
                  label="Effective APR"
                  value={formatPercent(detail.effectiveApr)}
                />
                <MetricCell
                  label="Pricing zone"
                  value={detail.pricingZone ? humanize(detail.pricingZone) : "-"}
                />
                <MetricCell
                  label="Live status"
                  value={humanize(detail.status)}
                />
                <MetricCell
                  label="Live reason"
                  value={humanize(detail.reason)}
                />
              </div>
            </section>
          </div>
        </>
      ) : loading ? (
        <p className="info-banner panel-banner">Loading live LP diagnostics...</p>
      ) : (
        <p className="detail-empty">No live diagnostics available for this row.</p>
      )}
    </section>
  );
}

function ScannerRowCard({
  row,
  displayedApr,
  timeToStart,
  expanded,
  onToggle,
  detail,
  detailError,
  detailLoading,
  quoteSizeInput,
  onQuoteSizeChange,
  defaultQuoteSize
}: {
  row: OpportunityRow;
  displayedApr: number | null;
  timeToStart: string;
  expanded: boolean;
  onToggle: () => void;
  detail: OpportunityDetailPayload | null;
  detailError: string | null;
  detailLoading: boolean;
  quoteSizeInput: string;
  onQuoteSizeChange: (value: string) => void;
  defaultQuoteSize: number;
}) {
  const question = row.marketUrl ? (
    <a
      className="market-link"
      href={row.marketUrl}
      rel="noreferrer"
      target="_blank"
    >
      {row.question}
    </a>
  ) : (
    row.question
  );

  return (
    <article className="market-row">
      <div className="market-visual">
        {row.image ? (
          <img src={row.image} alt="" loading="lazy" />
        ) : (
          <div className="image-fallback">{row.question.slice(0, 1).toUpperCase()}</div>
        )}
      </div>

      <div className="market-main">
        <div className="market-heading">
          <div className="heading-copy">
            <h2>{question}</h2>
            <p className="market-subhead">
              {row.sideToTrade} · {humanize(row.status)} · {humanize(row.reason)}
            </p>
          </div>

          <div className="tag-list">
            {row.tags.slice(0, 4).map((tag) => (
              <span key={`${row.marketId}-${tag}`}>{tag}</span>
            ))}
          </div>
        </div>

        <div className="market-metrics scanner-metrics">
          <MetricCell label="Displayed APR" value={formatPercent(displayedApr)} />
          <MetricCell label="Raw APR" value={formatPercent(row.rawApr)} />
          <MetricCell label="Reward / day" value={formatMoney(row.rewardDailyRate)} />
          <MetricCell label="Queue x" value={formatMultiple(row.queueMultiple)} />
          <MetricCell label="Spread x" value={formatMultiple(row.spreadRatio)} />
          <MetricCell
            label="Competitiveness"
            value={formatNumber(row.marketCompetitiveness, 2)}
          />
          <MetricCell label="Event time" value={formatTimestamp(row.eventStartTime)} />
          <MetricCell label="Time to start" value={timeToStart} />
          <MetricCell label="Timing" value={humanize(row.eventTiming)} />
          <MetricCell label="Suggested price" value={formatPrice(row.suggestedPrice)} />
        </div>

        <div className="market-actions">
          <button
            className={expanded ? "detail-button active" : "detail-button"}
            onClick={onToggle}
            type="button"
          >
            {expanded ? "Hide LP details" : "LP details"}
          </button>
          {row.marketUrl ? (
            <a
              className="market-open-link"
              href={row.marketUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open on Polymarket
            </a>
          ) : null}
        </div>

        {expanded ? (
          <LPDetailsPanel
            row={row}
            detail={detail}
            error={detailError}
            loading={detailLoading}
            quoteSizeInput={quoteSizeInput}
            onQuoteSizeChange={onQuoteSizeChange}
            defaultQuoteSize={defaultQuoteSize}
          />
        ) : null}
      </div>
    </article>
  );
}

export function LiveDashboard({
  initialScanner,
  initialError = null
}: Props) {
  const [scanner, setScanner] = useState<ScannerResponse | null>(initialScanner);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(initialScanner === null);
  const [countdownNowMs, setCountdownNowMs] = useState<number | null>(null);

  const [scannerSearch, setScannerSearch] = useState("");
  const [scannerTiming, setScannerTiming] = useState<TimingFilter>("upcoming");
  const [scannerTag, setScannerTag] = useState("");
  const [minApr, setMinApr] = useState("");
  const [scannerRows, setScannerRows] = useState(40);
  const [twoSided, setTwoSided] = useState(false);
  const [scannerSort, setScannerSort] = useState<ScannerSort>("effectiveApr");

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [quoteSizeInput, setQuoteSizeInput] = useState("");
  const [detailState, setDetailState] = useState<DetailState>({
    key: null,
    loading: false,
    error: null,
    data: null
  });

  useEffect(() => {
    setScannerSort(twoSided ? "rawApr" : "effectiveApr");
    setExpandedKey(null);
    setDetailState({ key: null, loading: false, error: null, data: null });
  }, [twoSided]);

  useEffect(() => {
    setCountdownNowMs(Date.now());
    const interval = window.setInterval(
      () => setCountdownNowMs(Date.now()),
      COUNTDOWN_TICK_MS
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const response = await fetch("/api/scanner", { cache: "no-store" });
        const payload = (await response.json()) as ScannerResponse & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Scanner request failed");
        }

        if (!cancelled) {
          setScanner(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Scanner refresh failed"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadData();
    const interval = window.setInterval(loadData, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const meta = scanner?.meta ?? null;
  const availableTags = scanner?.availableTags ?? [];
  const activeScannerRows = twoSided
    ? scanner?.twoSided.rows ?? []
    : scanner?.singleSided.rows ?? [];
  const detailMode: DetailMode = twoSided ? "two" : "single";
  const defaultQuoteSize = meta?.quoteSizeUsdc ?? 1000;
  const parsedQuoteSize = parsePositiveNumber(quoteSizeInput) ?? defaultQuoteSize;
  const isStale = meta?.snapshotHealth === "stale";
  const hasAnyData =
    (scanner?.singleSided.rows.length ?? 0) > 0 ||
    (scanner?.twoSided.rows.length ?? 0) > 0;

  const filteredScannerRows = useMemo(() => {
    const query = scannerSearch.trim().toLowerCase();
    const minAprValue = Number.parseFloat(minApr);

    const rows = activeScannerRows.filter((row) => {
      if (!matchesTiming(row.eventTiming, scannerTiming)) {
        return false;
      }
      if (scannerTag && !row.tags.includes(scannerTag)) {
        return false;
      }
      if (
        !matchesSearch(query, [
          row.question.toLowerCase(),
          row.sideToTrade.toLowerCase(),
          row.status.toLowerCase(),
          row.reason.toLowerCase(),
          ...row.tags.map((tag) => tag.toLowerCase())
        ])
      ) {
        return false;
      }

      if (Number.isFinite(minAprValue)) {
        const displayedApr = twoSided ? row.rawApr : row.effectiveApr;
        if ((displayedApr ?? Number.NEGATIVE_INFINITY) < minAprValue) {
          return false;
        }
      }

      return true;
    });

    rows.sort((left, right) => {
      switch (scannerSort) {
        case "rawApr":
          return (
            compareNullableDesc(left.rawApr, right.rawApr) ||
            compareNullableDesc(left.effectiveApr, right.effectiveApr) ||
            right.rewardDailyRate - left.rewardDailyRate
          );
        case "rewardDailyRate":
          return right.rewardDailyRate - left.rewardDailyRate;
        case "soonest":
          return (
            compareNullableAsc(
              left.eventStartTime ? new Date(left.eventStartTime).getTime() : null,
              right.eventStartTime ? new Date(right.eventStartTime).getTime() : null
            ) || compareNullableDesc(left.effectiveApr, right.effectiveApr)
          );
        case "queueMultiple":
          return compareNullableDesc(left.queueMultiple, right.queueMultiple);
        case "spreadRatio":
          return compareNullableAsc(left.spreadRatio, right.spreadRatio);
        case "effectiveApr":
        default:
          return (
            compareNullableDesc(left.effectiveApr, right.effectiveApr) ||
            compareNullableDesc(left.rawApr, right.rawApr) ||
            right.rewardDailyRate - left.rewardDailyRate
          );
      }
    });

    return rows.slice(0, scannerRows);
  }, [
    activeScannerRows,
    minApr,
    scannerRows,
    scannerSearch,
    scannerSort,
    scannerTag,
    scannerTiming,
    twoSided
  ]);

  useEffect(() => {
    if (
      expandedKey &&
      !filteredScannerRows.some((row) => rowKey(row, detailMode) === expandedKey)
    ) {
      setExpandedKey(null);
      setDetailState({ key: null, loading: false, error: null, data: null });
    }
  }, [detailMode, expandedKey, filteredScannerRows]);

  const expandedRow =
    expandedKey === null
      ? null
      : filteredScannerRows.find((row) => rowKey(row, detailMode) === expandedKey) ??
        null;

  useEffect(() => {
    if (!expandedRow || !meta) {
      setDetailState({ key: null, loading: false, error: null, data: null });
      return;
    }

    const requestKey = rowKey(expandedRow, detailMode);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setDetailState((current) => ({
          key: requestKey,
          loading: true,
          error: null,
          data: current.key === requestKey ? current.data : null
        }));

        const params = new URLSearchParams({
          marketId: expandedRow.marketId,
          tokenId: expandedRow.tokenId,
          mode: detailMode,
          quoteSizeUsdc: String(parsedQuoteSize)
        });
        const response = await fetch(`/api/opportunity-detail?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal
        });
        const payload = (await response.json()) as OpportunityDetailPayload & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Opportunity detail request failed");
        }

        setDetailState({
          key: requestKey,
          loading: false,
          error: null,
          data: payload
        });
      } catch (detailError) {
        if (controller.signal.aborted) {
          return;
        }

        setDetailState((current) => ({
          key: requestKey,
          loading: false,
          error:
            detailError instanceof Error
              ? detailError.message
              : "Opportunity detail request failed",
          data: current.key === requestKey ? current.data : null
        }));
      }
    }, DETAIL_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [detailMode, expandedRow, meta, parsedQuoteSize]);

  const staleMessage = meta?.warning
    ? `Snapshot published ${formatTimestamp(meta.generatedAt)} (${formatDurationFromMs(
        meta.snapshotAgeMs
      )} old). Source: ${humanize(meta.snapshotSource)}. ${meta.warning}`
    : null;

  return (
    <main className="app-shell">
      <section className="app-toolbar">
        <div className="toolbar-copy">
          <p className="eyebrow">Polymarket reward snapshot</p>
          <h1>Opportunities</h1>
          <p className="subtle">
            Ranked from the latest Rust snapshot. The browser refreshes every 30
            seconds; published data is on a five-minute cadence.
          </p>
        </div>
      </section>

      {staleMessage ? (
        <p className={isStale ? "warning-banner" : "info-banner"}>
          {staleMessage}
        </p>
      ) : null}

      <section className="filters-band">
        <div className="filter-grid">
          <label className="control control-wide">
            <span>Search</span>
            <input
              value={scannerSearch}
              onChange={(event) => setScannerSearch(event.target.value)}
              placeholder="Question, side, status, reason, tag"
            />
          </label>

          <label className="control">
            <span>Tag</span>
            <select
              value={scannerTag}
              onChange={(event) => setScannerTag(event.target.value)}
            >
              <option value="">All tags</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>

          <label className="control">
            <span>Min APR</span>
            <input
              inputMode="decimal"
              value={minApr}
              onChange={(event) => setMinApr(event.target.value)}
              placeholder="0"
            />
          </label>

          <label className="control">
            <span>Sort</span>
            <select
              value={scannerSort}
              onChange={(event) => setScannerSort(event.target.value as ScannerSort)}
            >
              <option value={twoSided ? "rawApr" : "effectiveApr"}>
                {twoSided ? "Raw APR" : "Effective APR"}
              </option>
              <option value="rewardDailyRate">Reward / day</option>
              <option value="soonest">Soonest</option>
              <option value="queueMultiple">Queue x</option>
              <option value="spreadRatio">Tightest spread</option>
            </select>
          </label>

          <label className="control control-select">
            <span>Rows</span>
            <select
              value={scannerRows}
              onChange={(event) => setScannerRows(Number(event.target.value))}
            >
              <option value={20}>20</option>
              <option value={40}>40</option>
              <option value={80}>80</option>
              <option value={120}>120</option>
            </select>
          </label>
        </div>

        <div className="toggle-row">
          <div className="toggle-group">
            <span>Timing</span>
            <FilterToggle
              label="Upcoming"
              value="upcoming"
              active={scannerTiming === "upcoming"}
              onClick={(value) => setScannerTiming(value as TimingFilter)}
            />
            <FilterToggle
              label="Started"
              value="started"
              active={scannerTiming === "started"}
              onClick={(value) => setScannerTiming(value as TimingFilter)}
            />
            <FilterToggle
              label="All"
              value="all"
              active={scannerTiming === "all"}
              onClick={(value) => setScannerTiming(value as TimingFilter)}
            />
          </div>

          <div className="toggle-group">
            <span>Mode</span>
            <FilterToggle
              label="Single-sided"
              value="single"
              active={!twoSided}
              onClick={() => setTwoSided(false)}
            />
            <FilterToggle
              label="Two-sided"
              value="two"
              active={twoSided}
              onClick={() => setTwoSided(true)}
            />
          </div>
        </div>
      </section>

      {error ? (
        <p className="error-banner">
          {hasAnyData ? `${error}. Last good snapshot remains on screen.` : error}
        </p>
      ) : null}

      <section className="market-list" aria-live="polite">
        {filteredScannerRows.map((row) => {
          const key = rowKey(row, detailMode);
          const expanded = expandedKey === key;
          return (
            <ScannerRowCard
              key={key}
              row={row}
              displayedApr={twoSided ? row.rawApr : row.effectiveApr}
              timeToStart={formatLiveTimeToStart(
                row.eventStartTime,
                row.timeToStartHuman,
                countdownNowMs
              )}
              expanded={expanded}
              onToggle={() => {
                if (expanded) {
                  setExpandedKey(null);
                  setDetailState({
                    key: null,
                    loading: false,
                    error: null,
                    data: null
                  });
                  return;
                }

                setExpandedKey(key);
                setQuoteSizeInput(String(defaultQuoteSize));
              }}
              detail={expanded ? detailState.data : null}
              detailError={expanded ? detailState.error : null}
              detailLoading={
                expanded &&
                detailState.key === key &&
                detailState.loading
              }
              quoteSizeInput={quoteSizeInput}
              onQuoteSizeChange={setQuoteSizeInput}
              defaultQuoteSize={defaultQuoteSize}
            />
          );
        })}

        {!loading && !error && filteredScannerRows.length === 0 ? (
          <p className="empty-state">No opportunity rows match the current filters.</p>
        ) : null}
      </section>
    </main>
  );
}
