"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time
} from "lightweight-charts";
import {
  Activity,
  BarChart3,
  ExternalLink,
  Radio,
  RefreshCw,
  Search,
  Wifi,
  WifiOff
} from "lucide-react";

import {
  Tabs,
  TabsList,
  TabsTrigger
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  OpportunityDetailPayload,
  PriceHistoryInterval
} from "@/lib/opportunity-detail";
import {
  applyLevelChange,
  deriveLiveDetail,
  levelsFromDepth,
  normalizeBookLevels,
  type BookLevel,
  type BookSide
} from "@/lib/orderbook-utils";
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
  | "twoSidedApr"
  | "rawApr"
  | "rewardDailyRate"
  | "soonest"
  | "queueMultiple"
  | "spreadRatio";

type InspectorTab = "execution" | "live";

type DetailState = {
  key: string | null;
  loading: boolean;
  error: string | null;
  data: OpportunityDetailPayload | null;
};

type ScannerRowViewModel = {
  key: string;
  marketId: string;
  tokenId: string;
  question: string;
  initial: string;
  tags: string[];
  derivedTiming: EventTiming;
  derivedTimeToStart: string;
  row: OpportunityRow;
};

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "stale";

const REFRESH_MS = 30_000;
const COUNTDOWN_TICK_MS = 30_000;
const DETAIL_DEBOUNCE_MS = 300;
const POLYMARKET_MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PRICE_HISTORY_INTERVALS: Array<{
  label: string;
  value: PriceHistoryInterval;
}> = [
  { label: "1m", value: "1m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "Max", value: "max" }
];

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

function formatAprRange(lower: number | null, upper: number | null, fallback = "-") {
  if (lower === null && upper === null) {
    return fallback;
  }
  if (lower !== null && upper !== null) {
    return `${formatPercent(lower)} – ${formatPercent(upper)}`;
  }
  if (lower !== null) {
    return `>= ${formatPercent(lower)}`;
  }
  return `<= ${formatPercent(upper)}`;
}

function formatOrderbookPrice(value: number | null) {
  if (value === null) {
    return "-";
  }

  const cents = value * 100;
  const rounded = Math.round(cents);
  return `${Math.abs(cents - rounded) < 0.01 ? rounded : formatNumber(cents, 1)}¢`;
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

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return "-";
  }

  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(timestamp)} UTC`;
}

function formatChartTime(time: Time) {
  const timestamp =
    typeof time === "number"
      ? time
      : typeof time === "string"
        ? Date.parse(time) / 1000
        : Date.UTC(time.year, time.month - 1, time.day) / 1000;

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp * 1000));
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

function formatSnapshotSource(value: string) {
  if (value === "public_url") {
    return "Public URL";
  }
  return humanize(value);
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

function rowKey(row: { marketId: string; tokenId: string }) {
  return `${row.marketId}:${row.tokenId}`;
}

function toFiniteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function connectionTone(state: ConnectionState): "neutral" | "green" | "blue" | "red" | "amber" {
  if (state === "live") {
    return "green";
  }
  if (state === "connecting") {
    return "blue";
  }
  if (state === "reconnecting") {
    return "amber";
  }
  if (state === "stale") {
    return "red";
  }
  return "neutral";
}

function formatLiveTimeToStart(
  eventStartTime: string | null,
  fallback: string | null,
  nowMs: number | null
) {
  if (!eventStartTime || nowMs === null) {
    return fallback ?? "-";
  }

  const eventTime = new Date(eventStartTime).getTime();
  if (!Number.isFinite(eventTime)) {
    return fallback ?? "-";
  }
  if (eventTime <= nowMs) {
    return "started";
  }

  return formatDurationFromMs(eventTime - nowMs);
}

function deriveTimingFromStart(
  row: OpportunityRow,
  nowMs: number
): EventTiming {
  if (!row.eventStartTime) {
    return row.eventTiming;
  }

  const eventTime = new Date(row.eventStartTime).getTime();
  if (!Number.isFinite(eventTime)) {
    return row.eventTiming;
  }

  return eventTime <= nowMs ? "started" : "upcoming";
}

function normalizeQuestion(row: OpportunityRow) {
  const question = row.question.trim();
  if (question.length > 0) {
    return question;
  }

  const fallbackId =
    row.marketId.trim().slice(0, 8) || row.tokenId.trim().slice(0, 8) || "unknown";
  return `Untitled market (${fallbackId})`;
}

function toScannerRowViewModel(
  row: OpportunityRow,
  nowMs: number
): ScannerRowViewModel {
  const question = normalizeQuestion(row);
  const firstCodePoint = Array.from(question)[0] ?? "?";

  return {
    key: rowKey(row),
    marketId: row.marketId,
    tokenId: row.tokenId,
    question,
    initial: firstCodePoint.toUpperCase(),
    tags: row.tags,
    derivedTiming: deriveTimingFromStart(row, nowMs),
    derivedTimeToStart: formatLiveTimeToStart(row.eventStartTime, row.timeToStartHuman, nowMs),
    row
  };
}

function hasAnyLiveDiagnostics(detail: OpportunityDetailPayload) {
  const { liveAvailability } = detail;
  return (
    liveAvailability.hasBids ||
    liveAvailability.hasAsks ||
    liveAvailability.hasPriceHistory
  );
}

function liveFallbackMessage(detail: OpportunityDetailPayload) {
  const { liveAvailability } = detail;
  if (liveAvailability.canRecomputeLiveMetrics) {
    return null;
  }

  switch (liveAvailability.fallbackReason) {
    case "missing_ask_side":
      return "Live asks are missing. Snapshot metrics stay in control for APR and qualification state.";
    case "missing_bid_side":
      return "Live bids are missing. Snapshot metrics stay in control for APR and qualification state.";
    case "missing_orderbook":
    case "incomplete_live_inputs":
    default:
      return "Live order book is incomplete. Snapshot metrics remain the source of truth.";
  }
}

function formatSnapshotStatus(row: OpportunityRow) {
  return `${humanize(row.status)} · ${humanize(row.reason)}`;
}

function readBookLevels(message: Record<string, unknown>, side: BookSide) {
  const key = side === "bids" ? "bids" : "asks";
  const rawLevels = Array.isArray(message[key]) ? message[key] : [];
  return rawLevels
    .map((entry) => {
      const value = entry as { price?: unknown; size?: unknown };
      const price = toFiniteNumber(value.price);
      const size = toFiniteNumber(value.size);
      if (price === null || size === null) {
        return null;
      }
      return { price, size };
    })
    .filter((level): level is BookLevel => level !== null);
}

function usePolymarketOrderbookStream(
  tokenId: string,
  initialDetail: OpportunityDetailPayload | null
) {
  const [detail, setDetail] = useState(initialDetail);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [updateCount, setUpdateCount] = useState(0);
  const [changedLevels, setChangedLevels] = useState<Set<string>>(new Set());
  const bidsRef = useRef<BookLevel[]>([]);
  const asksRef = useRef<BookLevel[]>([]);

  useEffect(() => {
    setDetail(initialDetail);
    setLastEventAt(null);
    setUpdateCount(0);
    setChangedLevels(new Set());
    bidsRef.current = initialDetail ? levelsFromDepth(initialDetail.depth.bids) : [];
    asksRef.current = initialDetail ? levelsFromDepth(initialDetail.depth.asks) : [];
  }, [initialDetail, tokenId]);

  useEffect(() => {
    if (!initialDetail || !tokenId) {
      setConnectionState("idle");
      return;
    }

    let closed = false;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;

    function applyLiveDetail(nextChanged: Set<string>, eventTimestamp?: unknown) {
      const fetchedAt =
        typeof eventTimestamp === "string" || typeof eventTimestamp === "number"
          ? new Date(Number(eventTimestamp)).toISOString()
          : new Date().toISOString();
      setDetail((current) => {
        if (!current) {
          return current;
        }
        return deriveLiveDetail(current, bidsRef.current, asksRef.current, fetchedAt);
      });
      setLastEventAt(fetchedAt);
      setUpdateCount((count) => count + 1);
      setChangedLevels(nextChanged);
      window.setTimeout(() => setChangedLevels(new Set()), 680);
    }

    function handleMessage(message: unknown) {
      const messages = Array.isArray(message) ? message : [message];
      for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== "object") {
          continue;
        }

        const event = rawMessage as Record<string, unknown>;
        const eventType = event.event_type ?? event.type;
        const changed = new Set<string>();

        if (eventType === "book" && event.asset_id === tokenId) {
          const bids = readBookLevels(event, "bids");
          const asks = readBookLevels(event, "asks");
          if (Array.isArray(event.bids)) {
            bidsRef.current = normalizeBookLevels(bids, "bids");
          }
          if (Array.isArray(event.asks)) {
            asksRef.current = normalizeBookLevels(asks, "asks");
          }
          for (const level of [...bids, ...asks]) {
            changed.add(`${level.price}`);
          }
          applyLiveDetail(changed, event.timestamp);
        }

        if (eventType === "price_change" && Array.isArray(event.price_changes)) {
          for (const change of event.price_changes as Array<Record<string, unknown>>) {
            if (change.asset_id !== tokenId) {
              continue;
            }
            const price = toFiniteNumber(change.price);
            const size = toFiniteNumber(change.size);
            if (price === null || size === null) {
              continue;
            }
            const side = change.side === "BUY" ? "bids" : "asks";
            if (side === "bids") {
              bidsRef.current = applyLevelChange(bidsRef.current, side, price, size);
            } else {
              asksRef.current = applyLevelChange(asksRef.current, side, price, size);
            }
            changed.add(`${price}`);
          }

          if (changed.size > 0) {
            applyLiveDetail(changed, event.timestamp);
          }
        }

        if (eventType === "last_trade_price") {
          const assetId = event.asset_id ?? event.assetId;
          const price = toFiniteNumber(event.price);
          if (assetId === tokenId && price !== null) {
            setDetail((current) => {
              if (!current) {
                return current;
              }
              const t = Math.floor(Date.now() / 1000);
              return {
                ...current,
                priceHistory: [...current.priceHistory.slice(-160), { t, p: price }]
              };
            });
            applyLiveDetail(new Set(), event.timestamp);
          }
        }
      }
    }

    function connect() {
      if (closed) {
        return;
      }

      setConnectionState(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(POLYMARKET_MARKET_WS);

      socket.onopen = () => {
        reconnectAttempt = 0;
        setConnectionState("live");
        socket?.send(
          JSON.stringify({
            type: "market",
            assets_ids: [tokenId],
            custom_feature_enabled: true
          })
        );
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("PING");
          }
        }, 10_000);
      };

      socket.onmessage = (event) => {
        if (event.data === "PONG") {
          return;
        }
        try {
          handleMessage(JSON.parse(event.data as string));
        } catch {
          // Ignore malformed websocket payloads without dropping the stream.
        }
      };

      socket.onerror = () => {
        setConnectionState("reconnecting");
      };

      socket.onclose = () => {
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (closed) {
          return;
        }
        reconnectAttempt += 1;
        setConnectionState(reconnectAttempt > 4 ? "stale" : "reconnecting");
        reconnectTimer = window.setTimeout(
          connect,
          Math.min(12_000, 800 * 2 ** reconnectAttempt)
        );
      };
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
      }
      socket?.close();
    };
  }, [initialDetail, tokenId]);

  return {
    detail,
    connectionState,
    lastEventAt,
    updateCount,
    changedLevels
  };
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

function KeyStat({
  label,
  value,
  emphasis = false
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className={emphasis ? "key-stat key-stat-emphasis" : "key-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelSection({
  title,
  children,
  description
}: {
  title: string;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <Card className="detail-card">
      <div className="detail-card-heading">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}

function PriceHistoryChart({
  detail,
  outcome,
  interval,
  onIntervalChange
}: {
  detail: OpportunityDetailPayload;
  outcome: string;
  interval: PriceHistoryInterval;
  onIntervalChange: (interval: PriceHistoryInterval) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const rewardFloorSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rewardCeilingSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [rewardOverlay, setRewardOverlay] = useState<{
    top: number;
    height: number;
  } | null>(null);
  const history = detail.priceHistory;
  const latest = history.at(-1) ?? null;

  function updateRewardOverlay() {
    const container = containerRef.current;
    const series = seriesRef.current;
    if (
      !container ||
      !series ||
      detail.rewardBand.bidLower === null ||
      detail.rewardBand.askUpper === null
    ) {
      setRewardOverlay(null);
      return;
    }

    const topCoordinate = series.priceToCoordinate(detail.rewardBand.askUpper * 100);
    const bottomCoordinate = series.priceToCoordinate(detail.rewardBand.bidLower * 100);
    if (topCoordinate === null || bottomCoordinate === null) {
      setRewardOverlay(null);
      return;
    }

    const top = Math.max(0, Math.min(topCoordinate, bottomCoordinate));
    const bottom = Math.min(
      container.clientHeight,
      Math.max(topCoordinate, bottomCoordinate)
    );
    setRewardOverlay({
      top,
      height: Math.max(6, bottom - top)
    });
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container || history.length === 0) {
      return;
    }
    const rootStyles = window.getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) =>
      rootStyles.getPropertyValue(name).trim() || fallback;
    const textColor = cssVar("--muted", "#9cb1c8");
    const borderColor = cssVar("--border", "#233246");
    const accent = cssVar("--green", "#39d98a");
    const monoFont = cssVar(
      "--mono",
      "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    );
    const crosshairColor = "rgba(57, 217, 138, 0.28)";

    const chart = createChart(container, {
      autoSize: true,
      height: 240,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor,
        fontFamily: monoFont,
        fontSize: 11
      },
      localization: {
        timeFormatter: formatChartTime
      },
      grid: {
        vertLines: { color: borderColor },
        horzLines: {
          color: borderColor,
          style: LineStyle.Dashed
        }
      },
      crosshair: {
        vertLine: { color: crosshairColor, width: 1 },
        horzLine: { color: crosshairColor, width: 1 }
      },
      rightPriceScale: {
        borderColor,
        scaleMargins: { top: 0.18, bottom: 0.16 }
      },
      timeScale: {
        borderColor,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatChartTime
      }
    });
    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: accent,
      lineWidth: 2,
      topColor: "rgba(57, 217, 138, 0.22)",
      bottomColor: "rgba(10, 15, 20, 0.06)",
      priceFormat: {
        type: "custom",
        formatter: (price: number) => `${formatNumber(price, 1)}¢`
      },
      lastValueVisible: true,
      priceLineVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 5
    });
    const rewardFloorSeries = chart.addSeries(LineSeries, {
      color: "rgba(125, 211, 252, 0)",
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false
    });
    const rewardCeilingSeries = chart.addSeries(LineSeries, {
      color: "rgba(125, 211, 252, 0)",
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false
    });

    chartRef.current = chart;
    seriesRef.current = areaSeries;
    rewardFloorSeriesRef.current = rewardFloorSeries;
    rewardCeilingSeriesRef.current = rewardCeilingSeries;

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ height: container.clientWidth > 740 ? 240 : 220 });
      chart.timeScale().fitContent();
      window.requestAnimationFrame(updateRewardOverlay);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      rewardFloorSeriesRef.current = null;
      rewardCeilingSeriesRef.current = null;
    };
  }, [history.length, interval]);

  useEffect(() => {
    const series = seriesRef.current;
    const rewardFloorSeries = rewardFloorSeriesRef.current;
    const rewardCeilingSeries = rewardCeilingSeriesRef.current;
    const chart = chartRef.current;
    if (
      !series ||
      !rewardFloorSeries ||
      !rewardCeilingSeries ||
      !chart ||
      history.length === 0
    ) {
      return;
    }

    const chartData = history.map((point) => ({
      time: point.t as Time,
      value: point.p * 100
    }));
    series.setData(chartData);
    rewardFloorSeries.setData(
      detail.rewardBand.bidLower === null
        ? []
        : chartData.map((point) => ({
            time: point.time,
            value: detail.rewardBand.bidLower! * 100
          }))
    );
    rewardCeilingSeries.setData(
      detail.rewardBand.askUpper === null
        ? []
        : chartData.map((point) => ({
            time: point.time,
            value: detail.rewardBand.askUpper! * 100
          }))
    );
    chart.timeScale().fitContent();
    window.requestAnimationFrame(updateRewardOverlay);
  }, [detail.rewardBand.askUpper, detail.rewardBand.bidLower, history]);

  return (
    <section className="price-history-card market-graph-card">
      <div className="lp-section-heading">
        <div>
          <h3>
            <BarChart3 size={18} />
            Live market
          </h3>
          <p>
            {history.length > 0
              ? `${
                  PRICE_HISTORY_INTERVALS.find((option) => option.value === interval)
                    ?.label ?? interval
                } price history · browser local time`
              : "No price history returned"}
          </p>
        </div>
        <div className="chart-range-tabs" aria-label="Price history interval">
          {PRICE_HISTORY_INTERVALS.map((option) => (
            <button
              aria-label={`Show ${option.label} price history`}
              aria-pressed={option.value === interval}
              key={option.value}
              className={option.value === interval ? "active" : ""}
              onClick={() => onIntervalChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="chart-terminal">
          <span>{outcome}</span>
          <strong>{formatOrderbookPrice(latest?.p ?? detail.bestBid)}</strong>
        </div>
      </div>

      <div className="price-chart-frame">
        {history.length === 0 ? (
          <div className="price-chart-empty">No price history returned</div>
        ) : (
          <>
            {rewardOverlay ? (
              <div
                className="chart-reward-overlay"
                style={{
                  top: `${rewardOverlay.top}px`,
                  height: `${rewardOverlay.height}px`
                }}
              />
            ) : null}
            <div ref={containerRef} className="price-history-canvas" />
          </>
        )}
      </div>
    </section>
  );
}

function OrderBookVisualization({
  detail,
  changedLevels,
  connectionState,
  lastEventAt,
  updateCount
}: {
  detail: OpportunityDetailPayload;
  changedLevels: Set<string>;
  connectionState: ConnectionState;
  lastEventAt: string | null;
  updateCount: number;
}) {
  const askRows = detail.depth.asks.slice(0, 8).reverse();
  const bidRows = detail.depth.bids.slice(0, 8);
  const maxDepth = Math.max(
    1,
    ...askRows.map((level) => level.cumulativeShares),
    ...bidRows.map((level) => level.cumulativeShares)
  );
  const spread =
    detail.bestAsk !== null && detail.bestBid !== null
      ? detail.bestAsk - detail.bestBid
      : null;

  return (
    <section className="orderbook-card live-orderbook-card">
      <div className="lp-section-heading">
        <div>
          <h3>
            <Radio size={18} />
            Order book
          </h3>
          <p>Public CLOB stream. Rewarded prices stay highlighted.</p>
        </div>
        <div className="book-summary">
          <Badge tone={connectionTone(connectionState)}>
            {connectionState === "live" ? <Wifi size={13} /> : <WifiOff size={13} />}
            {humanize(connectionState)}
          </Badge>
          <span>Last {formatOrderbookPrice(detail.priceHistory.at(-1)?.p ?? detail.bestBid)}</span>
          <span>Spread {formatOrderbookPrice(spread)}</span>
          <span>{updateCount} updates</span>
          {lastEventAt ? <span>{formatTimestamp(lastEventAt)}</span> : null}
        </div>
      </div>

      {askRows.length === 0 && bidRows.length === 0 ? (
        <p className="detail-empty">No live orderbook depth was returned.</p>
      ) : (
        <div className="orderbook-table">
          <div className="orderbook-row orderbook-header">
            <div>Price</div>
            <div>Shares</div>
            <div>Total</div>
          </div>
          {askRows.map((level) => (
            <div
              key={`ask-${level.price}-${level.cumulativeShares}`}
              className={
                [
                  "orderbook-row ask-row",
                  level.inRewardBand ? "is-rewarded" : "",
                  changedLevels.has(`${level.price}`) ? "is-updating" : "",
                  level.price === detail.bestAsk ? "is-best" : ""
                ].join(" ")
              }
              style={
                {
                  "--depth-width": `${(level.cumulativeShares / maxDepth) * 100}%`
                } as CSSProperties
              }
            >
              <div className="book-price">{formatOrderbookPrice(level.price)}</div>
              <div>{formatNumber(level.size, 2)}</div>
              <div>{formatMoney(level.cumulativeNotional)}</div>
            </div>
          ))}
          <div className="orderbook-spread-row">
            <span>Last {formatOrderbookPrice(detail.priceHistory.at(-1)?.p ?? detail.bestBid)}</span>
            <strong>Spread {formatOrderbookPrice(spread)}</strong>
          </div>
          {bidRows.map((level) => (
            <div
              key={`bid-${level.price}-${level.cumulativeShares}`}
              className={
                [
                  "orderbook-row bid-row",
                  level.inRewardBand ? "is-rewarded" : "",
                  level.isSuggested ? "is-suggested" : "",
                  changedLevels.has(`${level.price}`) ? "is-updating" : "",
                  level.price === detail.bestBid ? "is-best" : ""
                ].join(" ")
              }
              style={
                {
                  "--depth-width": `${(level.cumulativeShares / maxDepth) * 100}%`
                } as CSSProperties
              }
            >
              <div className="book-price">{formatOrderbookPrice(level.price)}</div>
              <div>{formatNumber(level.size, 2)}</div>
              <div>{formatMoney(level.cumulativeNotional)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ExecutionSnapshotFallback({ row }: { row: OpportunityRow }) {
  return (
    <PanelSection
      title="Snapshot fallback"
      description="Live depth is incomplete, so the snapshot ranking remains the execution reference."
    >
      <div className="detail-grid">
        <MetricCell label="Snapshot status" value={humanize(row.status)} />
        <MetricCell label="Snapshot reason" value={humanize(row.reason)} />
        <MetricCell label="Eff APR (1-sided)" value={formatPercent(row.effectiveApr)} />
        <MetricCell label="Eff APR (2-sided)" value={formatPercent(row.twoSidedApr)} />
        <MetricCell label="Suggested price" value={formatPrice(row.suggestedPrice)} />
        <MetricCell label="Queue x" value={formatMultiple(row.queueMultiple)} />
      </div>
    </PanelSection>
  );
}

function ExecutionSections({
  row,
  liveDetail,
  showSnapshotFallback
}: {
  row: OpportunityRow;
  liveDetail: OpportunityDetailPayload;
  showSnapshotFallback: boolean;
}) {
  return (
    <div className="detail-sections">
      <PanelSection title="Your quote" description="Execution economics first. Judge the queue before you move.">
        <div className="detail-grid">
          <MetricCell label="Suggested price" value={formatPrice(liveDetail.suggestedPrice)} />
          <MetricCell label="Your shares" value={formatShares(liveDetail.ownShares)} />
          <MetricCell
            label="Min qualifying quote"
            value={formatMoney(liveDetail.minimumQualifyingUsdc)}
          />
          <MetricCell label="Distance to ask" value={formatPrice(liveDetail.distanceToAsk)} />
          <MetricCell label="Queue ahead" value={formatShares(liveDetail.queueAheadShares)} />
          <MetricCell
            label="Queue ahead notional"
            value={formatMoney(liveDetail.queueAheadNotional)}
          />
          <MetricCell label="Queue x" value={formatMultiple(liveDetail.queueMultiple)} />
          <MetricCell
            label="Qualifying depth"
            value={formatShares(liveDetail.qualifyingDepthShares)}
          />
        </div>
      </PanelSection>

      <PanelSection title="Reward rules" description="Reward bands and qualification limits from the live payload.">
        <div className="detail-grid">
          <MetricCell label="Reward / day" value={formatMoney(row.rewardDailyRate)} />
          <MetricCell label="Max spread" value={`${formatNumber(liveDetail.rewardsMaxSpread, 2)}c`} />
          <MetricCell label="Min shares" value={formatShares(liveDetail.rewardsMinSize)} />
          <MetricCell
            label="Bid reward band"
            value={
              liveDetail.rewardBand.bidLower === null ||
              liveDetail.rewardBand.midpoint === null
                ? "-"
                : `${formatOrderbookPrice(
                    liveDetail.rewardBand.bidLower
                  )} to ${formatOrderbookPrice(liveDetail.rewardBand.midpoint)}`
            }
          />
          <MetricCell
            label="Ask reward band"
            value={
              liveDetail.rewardBand.midpoint === null ||
              liveDetail.rewardBand.askUpper === null
                ? "-"
                : `${formatOrderbookPrice(
                    liveDetail.rewardBand.midpoint
                  )} to ${formatOrderbookPrice(liveDetail.rewardBand.askUpper)}`
            }
          />
          <MetricCell label="Spread x" value={formatMultiple(liveDetail.spreadRatio)} />
        </div>
      </PanelSection>

      {showSnapshotFallback ? (
        <ExecutionSnapshotFallback row={row} />
      ) : (
        <PanelSection title="Estimated rewards" description="Live APR context after queue and depth are considered.">
          <div className="detail-grid">
            <MetricCell label="APR ceiling" value={formatPercent(liveDetail.aprCeiling)} />
            <MetricCell label="Raw APR" value={formatPercent(liveDetail.rawApr)} />
            <MetricCell label="Eff APR (1-sided)" value={formatPercent(liveDetail.effectiveApr)} />
            <MetricCell
              label="APR range (low-high)"
              value={formatAprRange(liveDetail.aprLower, liveDetail.aprUpper)}
            />
            <MetricCell label="Eff APR (2-sided)" value={formatPercent(liveDetail.twoSidedApr)} />
            <MetricCell
              label="Pricing zone"
              value={liveDetail.pricingZone ? humanize(liveDetail.pricingZone) : "-"}
            />
            <MetricCell label="Live status" value={humanize(liveDetail.status)} />
            <MetricCell label="Live reason" value={humanize(liveDetail.reason)} />
          </div>
        </PanelSection>
      )}
    </div>
  );
}

function SelectionPreviewPanel({
  row,
  onInspect,
  staleMessage
}: {
  row: ScannerRowViewModel | null;
  onInspect: (key: string) => void;
  staleMessage: string | null;
}) {
  if (!row) {
    return (
      <section className="inspector-panel inspector-panel-empty">
        <div className="inspector-empty-copy">
          <p className="eyebrow">No opportunities</p>
          <h2>Adjust the filters to bring rows back into focus.</h2>
        </div>
      </section>
    );
  }

  const rowData = row.row;
  return (
    <section className="inspector-panel inspector-panel-preview">
      <div className="inspector-header">
        <div className="inspector-heading">
          <p className="eyebrow">Selected opportunity</p>
          <h2>{row.question}</h2>
          <p className="inspector-subtitle">
            {rowData.sideToTrade} · {formatSnapshotStatus(rowData)}
          </p>
        </div>
        <div className="inspector-header-actions">
          <Badge tone={row.derivedTiming === "started" ? "amber" : "green"}>
            {humanize(row.derivedTiming)}
          </Badge>
          <Button
            className="inspector-primary-action"
            onClick={() => onInspect(row.key)}
            type="button"
            variant="secondary"
          >
            <Activity size={16} />
            Inspect live diagnostics
          </Button>
        </div>
      </div>

      <div className="inspector-hero">
        <KeyStat label="APR now" value={formatPercent(rowData.effectiveApr)} emphasis />
        <KeyStat label="Reward / day" value={formatMoney(rowData.rewardDailyRate)} />
        <KeyStat label="Time" value={row.derivedTimeToStart} />
      </div>

      <div className="preview-grid">
        <MetricCell label="2-sided APR" value={formatPercent(rowData.twoSidedApr)} />
        <MetricCell label="Suggested price" value={formatPrice(rowData.suggestedPrice)} />
        <MetricCell label="Queue x" value={formatMultiple(rowData.queueMultiple)} />
        <MetricCell label="Spread x" value={formatMultiple(rowData.spreadRatio)} />
        <MetricCell label="Competitiveness" value={formatNumber(rowData.marketCompetitiveness, 3)} />
        <MetricCell label="Tags" value={row.tags.slice(0, 3).join(" · ") || "-"} />
      </div>

      <div className="inspector-callout">
        <p>
          Preview stays snapshot-backed until you ask for live diagnostics. Use the
          inspect action when the row looks worth validating.
        </p>
        {staleMessage ? <p>{staleMessage}</p> : null}
      </div>
    </section>
  );
}

function ActiveInspectorPanel({
  row,
  detail,
  error,
  loading,
  quoteSizeInput,
  onQuoteSizeChange,
  defaultQuoteSize,
  priceHistoryInterval,
  onPriceHistoryIntervalChange,
  activeTab,
  onTabChange,
  onClose
}: {
  row: ScannerRowViewModel;
  detail: OpportunityDetailPayload | null;
  error: string | null;
  loading: boolean;
  quoteSizeInput: string;
  onQuoteSizeChange: (value: string) => void;
  defaultQuoteSize: number;
  priceHistoryInterval: PriceHistoryInterval;
  onPriceHistoryIntervalChange: (interval: PriceHistoryInterval) => void;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
}) {
  const streamed = usePolymarketOrderbookStream(row.tokenId, detail);
  const liveDetail = streamed.detail;
  const availability = liveDetail?.liveAvailability ?? null;
  const hasLiveDiagnostics = liveDetail ? hasAnyLiveDiagnostics(liveDetail) : false;
  const showOrderBook = availability ? availability.hasBids || availability.hasAsks : false;
  const showPriceHistory = availability ? hasLiveDiagnostics : false;
  const showSnapshotFallback = availability ? !availability.canRecomputeLiveMetrics : false;
  const showNoLiveDiagnostics = availability ? !hasLiveDiagnostics : false;
  const fallbackMessage = liveDetail ? liveFallbackMessage(liveDetail) : null;
  const liveStatusLabel =
    loading && !liveDetail ? "Refreshing live book..." : humanize(streamed.connectionState);

  return (
    <section className="inspector-panel inspector-panel-active" id={`lp-details-${row.marketId}-${row.tokenId}`}>
      <div className="inspector-header">
        <div className="inspector-heading">
          <p className="eyebrow">Live inspection</p>
          <h2>{row.question}</h2>
          <p className="inspector-subtitle">
            {row.row.sideToTrade} · {formatSnapshotStatus(row.row)}
          </p>
        </div>
        <div className="inspector-header-actions">
          <Badge tone={connectionTone(streamed.connectionState)}>
            <span className={`status-dot ${streamed.connectionState}`} />
            {liveStatusLabel}
          </Badge>
          {row.row.marketUrl ? (
            <a
              className="market-open-link inspector-market-link"
              href={row.row.marketUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink size={15} />
              Open market
            </a>
          ) : null}
          <Button onClick={onClose} type="button" variant="outline">
            Close
          </Button>
        </div>
      </div>

      <div className="inspector-hero inspector-hero-live">
        <KeyStat label="APR now" value={formatPercent(row.row.effectiveApr)} emphasis />
        <KeyStat label="Reward / day" value={formatMoney(row.row.rewardDailyRate)} />
        <KeyStat label="Time" value={row.derivedTimeToStart} />
      </div>

      <div className="inspector-toolbar">
        <label className="control inspector-control">
          <span>Quote size (USDC)</span>
          <Input
            inputMode="decimal"
            value={quoteSizeInput}
            onChange={(event) => onQuoteSizeChange(event.target.value)}
            placeholder={String(defaultQuoteSize)}
          />
        </label>
        <div className="inspector-meta-strip">
          <div>
            <span>Snapshot</span>
            <strong>{humanize(row.row.status)}</strong>
          </div>
          <div>
            <span>Reason</span>
            <strong>{humanize(row.row.reason)}</strong>
          </div>
          <div>
            <span>Live stream</span>
            <strong>{liveStatusLabel}</strong>
          </div>
        </div>
      </div>

      {error ? (
        <p className="error-banner panel-banner" role="alert">
          {error}
        </p>
      ) : null}

      {liveDetail ? (
        <>
          <p className="panel-note">
            Live book fetched {formatTimestamp(liveDetail.fetchedAt)}. Ranked snapshot
            published {formatTimestamp(liveDetail.snapshotGeneratedAt)}.
          </p>

          {fallbackMessage && !showNoLiveDiagnostics ? (
            <p className="info-banner panel-banner" role="status">
              {fallbackMessage}
            </p>
          ) : null}

          {showNoLiveDiagnostics ? (
            <p className="detail-empty" role="status">
              No live diagnostics are available for this row.
            </p>
          ) : null}

          <Tabs className="inspector-tabs">
            <TabsList className="inspector-tabs-list">
              <TabsTrigger
                active={activeTab === "execution"}
                aria-pressed={activeTab === "execution"}
                onClick={() => onTabChange("execution")}
              >
                Execution
              </TabsTrigger>
              <TabsTrigger
                active={activeTab === "live"}
                aria-pressed={activeTab === "live"}
                onClick={() => onTabChange("live")}
              >
                Live market
              </TabsTrigger>
            </TabsList>

            {activeTab === "execution" ? (
              <ExecutionSections
                row={row.row}
                liveDetail={liveDetail}
                showSnapshotFallback={showSnapshotFallback}
              />
            ) : (
              <div className="live-stack">
                {showPriceHistory ? (
                  <PriceHistoryChart
                    detail={liveDetail}
                    interval={priceHistoryInterval}
                    onIntervalChange={onPriceHistoryIntervalChange}
                    outcome={row.row.sideToTrade}
                  />
                ) : (
                  <PanelSection title="Live market" description="No live price history was returned for this row.">
                    <p className="detail-empty">No live price history was returned.</p>
                  </PanelSection>
                )}

                {showOrderBook ? (
                  <OrderBookVisualization
                    detail={liveDetail}
                    changedLevels={streamed.changedLevels}
                    connectionState={streamed.connectionState}
                    lastEventAt={streamed.lastEventAt}
                    updateCount={streamed.updateCount}
                  />
                ) : (
                  <PanelSection title="Order book" description="The live stream did not return usable public depth.">
                    <p className="detail-empty">No live orderbook depth was returned.</p>
                  </PanelSection>
                )}
              </div>
            )}
          </Tabs>
        </>
      ) : loading ? (
        <p className="info-banner panel-banner" role="status" aria-live="polite">
          Loading live LP diagnostics...
        </p>
      ) : (
        <p className="detail-empty" role="status">
          No live diagnostics are available for this row.
        </p>
      )}
    </section>
  );
}

function ScannerRowCard({
  row,
  rank,
  selected,
  inspecting,
  onSelect,
  onInspect
}: {
  row: ScannerRowViewModel;
  rank: number;
  selected: boolean;
  inspecting: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const rowData = row.row;

  return (
    <Card
      className={[
        "market-row",
        selected ? "is-selected" : "",
        inspecting ? "is-inspecting" : ""
      ].join(" ")}
    >
      <button
        className="market-row-main"
        onClick={onSelect}
        type="button"
      >
        <div className="rank-cell">
          <span>{String(rank).padStart(2, "0")}</span>
        </div>

        <div className="market-row-info">
          <div className="market-heading">
            <div className="market-visual">
              {rowData.image ? (
                <img
                  src={rowData.image}
                  alt={`${row.question} market image`}
                  loading="lazy"
                />
              ) : (
                <div className="image-fallback">{row.initial}</div>
              )}
            </div>

            <div className="heading-text">
              <h3>{row.question}</h3>
              <p className="market-subhead">
                {rowData.sideToTrade} · {formatSnapshotStatus(rowData)}
              </p>
              <div className="tag-list">
                {row.tags.slice(0, 2).map((tag) => (
                  <Badge key={`${row.marketId}-${tag}`} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="market-row-apr">
          <span>APR now</span>
          <strong>{formatPercent(rowData.effectiveApr)}</strong>
        </div>

        <div className="market-row-secondary">
          <div>
            <span>Reward / day</span>
            <strong>{formatMoney(rowData.rewardDailyRate)}</strong>
          </div>
          <div>
            <span>Time</span>
            <strong>{row.derivedTimeToStart}</strong>
          </div>
        </div>
      </button>

      <div className="market-actions">
        <Button
          aria-pressed={inspecting}
          className={inspecting ? "detail-button active" : "detail-button"}
          onClick={onInspect}
          type="button"
          variant={inspecting ? "secondary" : "default"}
        >
          <Activity size={16} />
          {inspecting ? "Inspecting" : "Inspect live"}
        </Button>
        {rowData.marketUrl ? (
          <a
            aria-label={`Open ${row.question} on Polymarket`}
            className="market-open-link"
            href={rowData.marketUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={15} />
            Open market
          </a>
        ) : null}
      </div>
    </Card>
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
  const [showExtreme, setShowExtreme] = useState(false);
  const [scannerSort, setScannerSort] = useState<ScannerSort>("effectiveApr");

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeDetailKey, setActiveDetailKey] = useState<string | null>(null);
  const [quoteSizeInput, setQuoteSizeInput] = useState("");
  const [priceHistoryInterval, setPriceHistoryInterval] =
    useState<PriceHistoryInterval>("6h");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("execution");
  const [detailState, setDetailState] = useState<DetailState>({
    key: null,
    loading: false,
    error: null,
    data: null
  });
  const inspectorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setScannerSort(showExtreme ? "twoSidedApr" : "effectiveApr");
    setSelectedKey(null);
    setActiveDetailKey(null);
    setDetailState({ key: null, loading: false, error: null, data: null });
  }, [showExtreme]);

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
  const activeScannerRows = showExtreme
    ? scanner?.extreme.rows ?? []
    : scanner?.neutral.rows ?? [];
  const referenceNowMs = countdownNowMs ?? Date.now();
  const activeScannerViewRows = useMemo(
    () =>
      activeScannerRows.map((row) => toScannerRowViewModel(row, referenceNowMs)),
    [activeScannerRows, referenceNowMs]
  );
  const defaultQuoteSize = meta?.quoteSizeUsdc ?? 1000;
  const parsedQuoteSize = parsePositiveNumber(quoteSizeInput) ?? defaultQuoteSize;
  const isStale = meta?.snapshotHealth === "stale";
  const hasAnyData =
    (scanner?.neutral.rows.length ?? 0) > 0 ||
    (scanner?.extreme.rows.length ?? 0) > 0;
  const visibleTags = useMemo(
    () =>
      Array.from(new Set(activeScannerViewRows.flatMap((row) => row.tags))).sort((left, right) =>
        left.localeCompare(right)
      ),
    [activeScannerViewRows]
  );

  useEffect(() => {
    if (scannerTag && !visibleTags.includes(scannerTag)) {
      setScannerTag("");
    }
  }, [scannerTag, visibleTags]);

  const filteredScannerRows = useMemo(() => {
    const query = scannerSearch.trim().toLowerCase();
    const minAprValue = Number.parseFloat(minApr);

    const rows = activeScannerViewRows.filter((viewRow) => {
      const row = viewRow.row;
      if (!matchesTiming(viewRow.derivedTiming, scannerTiming)) {
        return false;
      }
      if (scannerTag && !row.tags.includes(scannerTag)) {
        return false;
      }
      if (
        !matchesSearch(query, [
          viewRow.question.toLowerCase(),
          row.sideToTrade.toLowerCase(),
          row.status.toLowerCase(),
          row.reason.toLowerCase(),
          ...row.tags.map((tag) => tag.toLowerCase())
        ])
      ) {
        return false;
      }

      if (Number.isFinite(minAprValue)) {
        const aprForThreshold = showExtreme ? row.twoSidedApr : row.effectiveApr;
        if ((aprForThreshold ?? Number.NEGATIVE_INFINITY) < minAprValue) {
          return false;
        }
      }

      return true;
    });

    rows.sort((left, right) => {
      const leftRow = left.row;
      const rightRow = right.row;
      switch (scannerSort) {
        case "twoSidedApr":
          return (
            compareNullableDesc(leftRow.twoSidedApr, rightRow.twoSidedApr) ||
            compareNullableDesc(leftRow.effectiveApr, rightRow.effectiveApr) ||
            rightRow.rewardDailyRate - leftRow.rewardDailyRate
          );
        case "rawApr":
          return (
            compareNullableDesc(leftRow.rawApr, rightRow.rawApr) ||
            compareNullableDesc(leftRow.effectiveApr, rightRow.effectiveApr) ||
            rightRow.rewardDailyRate - leftRow.rewardDailyRate
          );
        case "rewardDailyRate":
          return rightRow.rewardDailyRate - leftRow.rewardDailyRate;
        case "soonest":
          return (
            compareNullableAsc(
              leftRow.eventStartTime ? new Date(leftRow.eventStartTime).getTime() : null,
              rightRow.eventStartTime ? new Date(rightRow.eventStartTime).getTime() : null
            ) || compareNullableDesc(leftRow.effectiveApr, rightRow.effectiveApr)
          );
        case "queueMultiple":
          return compareNullableDesc(leftRow.queueMultiple, rightRow.queueMultiple);
        case "spreadRatio":
          return compareNullableAsc(leftRow.spreadRatio, rightRow.spreadRatio);
        case "effectiveApr":
        default:
          return (
            compareNullableDesc(leftRow.effectiveApr, rightRow.effectiveApr) ||
            compareNullableDesc(leftRow.twoSidedApr, rightRow.twoSidedApr) ||
            rightRow.rewardDailyRate - leftRow.rewardDailyRate
          );
      }
    });

    return rows.slice(0, scannerRows);
  }, [
    activeScannerViewRows,
    minApr,
    scannerRows,
    scannerSearch,
    scannerSort,
    scannerTag,
    scannerTiming,
    showExtreme
  ]);

  useEffect(() => {
    if (filteredScannerRows.length === 0) {
      setSelectedKey(null);
      setActiveDetailKey(null);
      setDetailState({ key: null, loading: false, error: null, data: null });
      return;
    }

    if (!selectedKey || !filteredScannerRows.some((row) => row.key === selectedKey)) {
      setSelectedKey(filteredScannerRows[0].key);
    }

    if (activeDetailKey && !filteredScannerRows.some((row) => row.key === activeDetailKey)) {
      setActiveDetailKey(null);
      setDetailState({ key: null, loading: false, error: null, data: null });
    }
  }, [activeDetailKey, filteredScannerRows, selectedKey]);

  const selectedRow =
    selectedKey === null
      ? filteredScannerRows[0] ?? null
      : filteredScannerRows.find((row) => row.key === selectedKey) ?? filteredScannerRows[0] ?? null;

  const activeDetailRow =
    activeDetailKey === null
      ? null
      : filteredScannerRows.find((row) => row.key === activeDetailKey) ?? null;

  useEffect(() => {
    if (!activeDetailRow || !meta) {
      setDetailState({ key: null, loading: false, error: null, data: null });
      return;
    }

    const requestKey = rowKey(activeDetailRow);
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
          marketId: activeDetailRow.marketId,
          tokenId: activeDetailRow.tokenId,
          quoteSizeUsdc: String(parsedQuoteSize),
          interval: priceHistoryInterval
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
  }, [activeDetailRow, meta, parsedQuoteSize, priceHistoryInterval]);

  useEffect(() => {
    if (!activeDetailKey) {
      return;
    }
    setInspectorTab("execution");
    if (typeof window === "undefined") {
      return;
    }
    if (!window.matchMedia("(max-width: 1279px)").matches) {
      return;
    }
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    inspectorRef.current?.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion ? "auto" : "smooth"
    });
  }, [activeDetailKey]);

  const staleMessage = meta?.warning
    ? `Snapshot ${formatDurationFromMs(meta.snapshotAgeMs)} old · ${formatSnapshotSource(
        meta.snapshotSource
      )} · ${meta.warning}`
    : null;

  const heroMeta = meta
    ? `${formatTimestamp(meta.generatedAt)} · refreshes every 30s · publish cadence 5m`
    : "Waiting for snapshot metadata";

  return (
    <main className="app-shell">
      <section className="app-toolbar">
        <div className="toolbar-copy">
          <p className="eyebrow">Polymarket reward scanner</p>
          <h1>Opportunity console</h1>
          <p className="subtle">
            Snapshot ranking first, live validation second. Scan hard, open detail only
            when the row earns it.
          </p>
        </div>
        <div className="toolbar-meta">
          <div>
            <span>Mode</span>
            <strong>{showExtreme ? "Extreme pricing" : "Neutral pricing"}</strong>
          </div>
          <div>
            <span>Snapshot</span>
            <strong>{heroMeta}</strong>
          </div>
        </div>
      </section>

      {staleMessage ? (
        <p
          className={isStale ? "warning-banner" : "info-banner"}
          role="status"
          aria-live="polite"
        >
          <RefreshCw size={14} />
          {staleMessage}
        </p>
      ) : null}

      <section className="filters-band" aria-label="Scanner filters">
        <div className="filter-cluster">
          <p>Search</p>
          <label className="control control-wide">
            <div className="input-with-icon">
              <Search size={16} />
              <Input
                value={scannerSearch}
                onChange={(event) => setScannerSearch(event.target.value)}
                placeholder="Question, side, status, reason, tag"
              />
            </div>
          </label>

          <label className="control">
            <Select
              value={scannerTag}
              onChange={(event) => setScannerTag(event.target.value)}
            >
              <option value="">All tags</option>
              {visibleTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="filter-cluster">
          <p>Rank</p>
          <label className="control">
            <Input
              inputMode="decimal"
              value={minApr}
              onChange={(event) => setMinApr(event.target.value)}
              placeholder="Min APR"
            />
          </label>

          <label className="control">
            <Select
              value={scannerSort}
              onChange={(event) => setScannerSort(event.target.value as ScannerSort)}
            >
              <option value="effectiveApr">Effective APR (1-sided)</option>
              <option value="twoSidedApr">Effective APR (2-sided)</option>
              <option value="rewardDailyRate">Reward / day</option>
              <option value="soonest">Soonest</option>
              <option value="queueMultiple">Queue x</option>
              <option value="spreadRatio">Tightest spread</option>
            </Select>
          </label>

          <label className="control">
            <Select
              value={scannerRows}
              onChange={(event) => setScannerRows(Number(event.target.value))}
            >
              <option value={20}>20 rows</option>
              <option value={40}>40 rows</option>
              <option value={80}>80 rows</option>
              <option value={120}>120 rows</option>
            </Select>
          </label>
        </div>

        <div className="toggle-row">
          <div className="toggle-group" role="group" aria-label="Timing filter">
            <span>Timing</span>
            <Button
              aria-pressed={scannerTiming === "upcoming"}
              className={scannerTiming === "upcoming" ? "toggle-chip active" : "toggle-chip"}
              onClick={() => setScannerTiming("upcoming")}
              type="button"
              variant={scannerTiming === "upcoming" ? "secondary" : "ghost"}
            >
              Upcoming
            </Button>
            <Button
              aria-pressed={scannerTiming === "started"}
              className={scannerTiming === "started" ? "toggle-chip active" : "toggle-chip"}
              onClick={() => setScannerTiming("started")}
              type="button"
              variant={scannerTiming === "started" ? "secondary" : "ghost"}
            >
              Started
            </Button>
            <Button
              aria-pressed={scannerTiming === "all"}
              className={scannerTiming === "all" ? "toggle-chip active" : "toggle-chip"}
              onClick={() => setScannerTiming("all")}
              type="button"
              variant={scannerTiming === "all" ? "secondary" : "ghost"}
            >
              All
            </Button>
          </div>

          <div className="toggle-group" role="group" aria-label="Pricing zone filter">
            <span>Zone</span>
            <Button
              aria-pressed={!showExtreme}
              className={!showExtreme ? "toggle-chip active" : "toggle-chip"}
              onClick={() => setShowExtreme(false)}
              type="button"
              variant={!showExtreme ? "secondary" : "ghost"}
            >
              Neutral
            </Button>
            <Button
              aria-pressed={showExtreme}
              className={showExtreme ? "toggle-chip active" : "toggle-chip"}
              onClick={() => setShowExtreme(true)}
              type="button"
              variant={showExtreme ? "secondary" : "ghost"}
            >
              Extreme
            </Button>
          </div>
        </div>
      </section>

      {error ? (
        <p className="error-banner" role="alert">
          {hasAnyData ? `${error}. Last good snapshot remains in view.` : error}
        </p>
      ) : null}

      <section className="dashboard-workspace">
        <section
          className="market-pane"
          aria-live="polite"
          aria-busy={loading}
          aria-label="Opportunity rows"
        >
          <div className="market-pane-header">
            <div>
              <p className="eyebrow">Ranking rail</p>
              <h2>APR leads, execution follows.</h2>
            </div>
            <p>
              {filteredScannerRows.length} of {activeScannerViewRows.length} rows visible
            </p>
          </div>

          <div className="market-list">
            {filteredScannerRows.map((viewRow, index) => (
              <ScannerRowCard
                key={viewRow.key}
                row={viewRow}
                rank={index + 1}
                selected={selectedKey === viewRow.key}
                inspecting={activeDetailKey === viewRow.key}
                onSelect={() => setSelectedKey(viewRow.key)}
                onInspect={() => {
                  setSelectedKey(viewRow.key);
                  setActiveDetailKey(viewRow.key);
                  setQuoteSizeInput((current) => current || String(defaultQuoteSize));
                }}
              />
            ))}

            {!loading && !error && filteredScannerRows.length === 0 ? (
              <p className="empty-state">No opportunity rows match the current filters.</p>
            ) : null}
          </div>
        </section>

        <section className="inspector-pane" ref={inspectorRef}>
          {selectedRow && activeDetailKey === selectedRow.key ? (
            <ActiveInspectorPanel
              row={selectedRow}
              detail={detailState.data}
              error={detailState.error}
              loading={detailState.loading}
              quoteSizeInput={quoteSizeInput}
              onQuoteSizeChange={setQuoteSizeInput}
              defaultQuoteSize={defaultQuoteSize}
              priceHistoryInterval={priceHistoryInterval}
              onPriceHistoryIntervalChange={setPriceHistoryInterval}
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              onClose={() => {
                setActiveDetailKey(null);
                setDetailState({ key: null, loading: false, error: null, data: null });
              }}
            />
          ) : (
            <SelectionPreviewPanel
              row={selectedRow}
              onInspect={(key) => {
                setSelectedKey(key);
                setActiveDetailKey(key);
                setQuoteSizeInput((current) => current || String(defaultQuoteSize));
              }}
              staleMessage={staleMessage}
            />
          )}
        </section>
      </section>
    </main>
  );
}
