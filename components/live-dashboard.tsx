"use client";

import { useEffect, useMemo, useState } from "react";

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

const REFRESH_MS = 30_000;
const COUNTDOWN_TICK_MS = 30_000;

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
  return `${hours}h ${remainingMinutes}m`;
}

function formatLiveTimeToStart(eventStartTime: string | null, fallback: string | null, nowMs: number) {
  if (!eventStartTime) {
    return fallback ?? "-";
  }

  const eventMs = new Date(eventStartTime).getTime();
  if (Number.isNaN(eventMs)) {
    return fallback ?? "-";
  }

  return formatDurationFromMs(eventMs - nowMs);
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

function ScannerRowCard({
  row,
  displayedApr,
  nowMs
}: {
  row: OpportunityRow;
  displayedApr: number | null;
  nowMs: number;
}) {
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
            <h2>
              {row.marketUrl ? (
                <a className="market-title-link" href={row.marketUrl} rel="noreferrer" target="_blank">
                  {row.question}
                </a>
              ) : (
                row.question
              )}
            </h2>
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
          <div>
            <span>Displayed APR</span>
            <strong>{formatPercent(displayedApr)}</strong>
          </div>
          <div>
            <span>Raw APR</span>
            <strong>{formatPercent(row.rawApr)}</strong>
          </div>
          <div>
            <span>Reward / day</span>
            <strong>{formatMoney(row.rewardDailyRate)}</strong>
          </div>
          <div>
            <span>Queue x</span>
            <strong>{formatMultiple(row.queueMultiple)}</strong>
          </div>
          <div>
            <span>Spread x</span>
            <strong>{formatMultiple(row.spreadRatio)}</strong>
          </div>
          <div>
            <span>Competitiveness</span>
            <strong>{formatNumber(row.marketCompetitiveness, 2)}</strong>
          </div>
          <div>
            <span>Event time</span>
            <strong>{formatTimestamp(row.eventStartTime)}</strong>
          </div>
          <div>
            <span>Time to start</span>
            <strong>{formatLiveTimeToStart(row.eventStartTime, row.timeToStartHuman, nowMs)}</strong>
          </div>
          <div>
            <span>Timing</span>
            <strong>{humanize(row.eventTiming)}</strong>
          </div>
          <div>
            <span>Suggested price</span>
            <strong>{row.suggestedPrice === null ? "-" : `${formatNumber(row.suggestedPrice, 3)}`}</strong>
          </div>
        </div>
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
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [scannerSearch, setScannerSearch] = useState("");
  const [scannerTiming, setScannerTiming] = useState<TimingFilter>("upcoming");
  const [scannerTag, setScannerTag] = useState("");
  const [minApr, setMinApr] = useState("");
  const [scannerRows, setScannerRows] = useState(40);
  const [twoSided, setTwoSided] = useState(false);
  const [scannerSort, setScannerSort] = useState<ScannerSort>("effectiveApr");

  useEffect(() => {
    setScannerSort(twoSided ? "rawApr" : "effectiveApr");
  }, [twoSided]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const scannerResult = await fetch("/api/scanner", { cache: "no-store" }).then(async (response) => {
          const payload = (await response.json()) as ScannerResponse & { error?: string };
          if (!response.ok) {
            throw new Error(payload.error ?? "Scanner request failed");
          }
          return payload;
        });

        if (cancelled) {
          return;
        }

        setScanner(scannerResult);
        setError(null);
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : "Scanner refresh failed");
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

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, COUNTDOWN_TICK_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const meta = scanner?.meta ?? null;
  const availableTags = scanner?.availableTags ?? [];
  const activeScannerRows = twoSided ? scanner?.twoSided.rows ?? [] : scanner?.singleSided.rows ?? [];
  const isStale = meta?.snapshotHealth === "stale";
  const staleMessage = meta?.warning ?? null;
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
  }, [activeScannerRows, minApr, scannerRows, scannerSearch, scannerSort, scannerTag, scannerTiming, twoSided]);

  return (
    <main className="app-shell">
      <section className="app-toolbar">
        <div className="toolbar-copy">
          <p className="eyebrow">Polymarket reward snapshot</p>
          <h1>Opportunities</h1>
          <p className="subtle">
            Browser refreshes every 30 seconds. Time to start updates live from event time.
          </p>
        </div>
      </section>

      {staleMessage ? (
        <p className={isStale ? "warning-banner" : "info-banner"}>
          {meta
            ? `Snapshot published ${formatTimestamp(meta.generatedAt)}. ${staleMessage}`
            : staleMessage}
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
            <select value={scannerTag} onChange={(event) => setScannerTag(event.target.value)}>
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
            <select value={scannerSort} onChange={(event) => setScannerSort(event.target.value as ScannerSort)}>
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
            <select value={scannerRows} onChange={(event) => setScannerRows(Number(event.target.value))}>
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
            <FilterToggle label="Upcoming" value="upcoming" active={scannerTiming === "upcoming"} onClick={(value) => setScannerTiming(value as TimingFilter)} />
            <FilterToggle label="Started" value="started" active={scannerTiming === "started"} onClick={(value) => setScannerTiming(value as TimingFilter)} />
            <FilterToggle label="All" value="all" active={scannerTiming === "all"} onClick={(value) => setScannerTiming(value as TimingFilter)} />
          </div>

          <div className="toggle-group">
            <span>Mode</span>
            <FilterToggle label="Single-sided" value="single" active={!twoSided} onClick={() => setTwoSided(false)} />
            <FilterToggle label="Two-sided" value="two" active={twoSided} onClick={() => setTwoSided(true)} />
          </div>
        </div>
      </section>

      {error ? (
        <p className="error-banner">
          {hasAnyData ? `${error}. Last good snapshot remains on screen.` : error}
        </p>
      ) : null}

      <section className="market-list" aria-live="polite">
        {filteredScannerRows.map((row) => (
            <ScannerRowCard
              key={`${row.marketId}-${row.tokenId}`}
              row={row}
              displayedApr={twoSided ? row.rawApr : row.effectiveApr}
              nowMs={nowMs}
            />
        ))}

        {!loading && !error && filteredScannerRows.length === 0 ? (
          <p className="empty-state">No scanner rows match the current filters.</p>
        ) : null}
      </section>
    </main>
  );
}
