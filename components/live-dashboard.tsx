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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

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

type DetailState = {
  key: string | null;
  loading: boolean;
  error: string | null;
  data: OpportunityDetailPayload | null;
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

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
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

function rowKey(row: OpportunityRow) {
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
    <Button
      className={active ? "toggle-chip active" : "toggle-chip"}
      onClick={() => onClick(value)}
      type="button"
      variant={active ? "secondary" : "ghost"}
    >
      {label}
    </Button>
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
          if (bids.length > 0) {
            bidsRef.current = normalizeBookLevels(bids, "bids");
          }
          if (asks.length > 0) {
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

    const chart = createChart(container, {
      autoSize: true,
      height: 340,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        fontSize: 12
      },
      localization: {
        timeFormatter: formatChartTime
      },
      grid: {
        vertLines: { color: "rgba(51, 65, 85, 0.16)" },
        horzLines: {
          color: "rgba(71, 85, 105, 0.38)",
          style: LineStyle.Dashed
        }
      },
      crosshair: {
        vertLine: { color: "rgba(125, 211, 252, 0.32)", width: 1 },
        horzLine: { color: "rgba(125, 211, 252, 0.32)", width: 1 }
      },
      rightPriceScale: {
        borderColor: "rgba(51, 65, 85, 0.65)",
        scaleMargins: { top: 0.18, bottom: 0.16 }
      },
      timeScale: {
        borderColor: "rgba(51, 65, 85, 0.65)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatChartTime
      }
    });
    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: "#8ec5ff",
      lineWidth: 3,
      topColor: "rgba(56, 189, 248, 0.28)",
      bottomColor: "rgba(15, 23, 42, 0.02)",
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
      chart.applyOptions({ height: container.clientWidth > 980 ? 340 : 280 });
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
            Market graph
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
            Order Book
          </h3>
          <p>Streaming public CLOB events. Rewarded prices are highlighted.</p>
        </div>
        <div className="book-summary">
          <Badge tone={connectionTone(connectionState)}>
            {connectionState === "live" ? <Wifi size={13} /> : <WifiOff size={13} />}
            {humanize(connectionState)}
          </Badge>
          <span>Last: {formatOrderbookPrice(detail.priceHistory.at(-1)?.p ?? detail.bestBid)}</span>
          <span>Spread: {formatOrderbookPrice(spread)}</span>
          <span>{updateCount} updates</span>
          {lastEventAt ? <span>Last event {formatTimestamp(lastEventAt)}</span> : null}
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
            <span>Last: {formatOrderbookPrice(detail.priceHistory.at(-1)?.p ?? detail.bestBid)}</span>
            <strong>Spread: {formatOrderbookPrice(spread)}</strong>
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

function LPDetailsPanel({
  row,
  detail,
  error,
  loading,
  quoteSizeInput,
  onQuoteSizeChange,
  defaultQuoteSize,
  priceHistoryInterval,
  onPriceHistoryIntervalChange
}: {
  row: OpportunityRow;
  detail: OpportunityDetailPayload | null;
  error: string | null;
  loading: boolean;
  quoteSizeInput: string;
  onQuoteSizeChange: (value: string) => void;
  defaultQuoteSize: number;
  priceHistoryInterval: PriceHistoryInterval;
  onPriceHistoryIntervalChange: (interval: PriceHistoryInterval) => void;
}) {
  const streamed = usePolymarketOrderbookStream(row.tokenId, detail);
  const liveDetail = streamed.detail;
  const liveStatusLabel =
    loading && !liveDetail ? "Refreshing live book..." : humanize(streamed.connectionState);

  return (
    <section className="lp-panel">
      <div className="lp-panel-toolbar">
        <label className="control lp-quote-control">
          <span>Quote size (USDC)</span>
          <Input
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
          <strong>
            <span className={`status-dot ${streamed.connectionState}`} />
            {liveStatusLabel}
          </strong>
        </div>
      </div>

      {error ? <p className="error-banner panel-banner">{error}</p> : null}

      {liveDetail ? (
        <>
          <p className="panel-note">
            Live book fetched {formatTimestamp(liveDetail.fetchedAt)}. Ranked snapshot
            was published {formatTimestamp(liveDetail.snapshotGeneratedAt)}.
          </p>

          <PriceHistoryChart
            detail={liveDetail}
            interval={priceHistoryInterval}
            onIntervalChange={onPriceHistoryIntervalChange}
            outcome={row.sideToTrade}
          />
          <OrderBookVisualization
            detail={liveDetail}
            changedLevels={streamed.changedLevels}
            connectionState={streamed.connectionState}
            lastEventAt={streamed.lastEventAt}
            updateCount={streamed.updateCount}
          />

          <div className="detail-sections">
            <Card className="detail-card">
              <h3>Reward rules</h3>
              <div className="detail-grid">
                <MetricCell
                  label="Reward / day"
                  value={formatMoney(row.rewardDailyRate)}
                />
                <MetricCell
                  label="Max spread"
                  value={`${formatNumber(liveDetail.rewardsMaxSpread, 2)}c`}
                />
                <MetricCell
                  label="Min shares"
                  value={formatShares(liveDetail.rewardsMinSize)}
                />
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
                <MetricCell
                  label="Spread x"
                  value={formatMultiple(liveDetail.spreadRatio)}
                />
              </div>
            </Card>

            <Card className="detail-card">
              <h3>Your quote</h3>
              <div className="detail-grid">
                <MetricCell
                  label="Suggested price"
                  value={formatPrice(liveDetail.suggestedPrice)}
                />
                <MetricCell label="Your shares" value={formatShares(liveDetail.ownShares)} />
                <MetricCell
                  label="Min qualifying quote"
                  value={formatMoney(liveDetail.minimumQualifyingUsdc)}
                />
                <MetricCell
                  label="Distance to ask"
                  value={formatPrice(liveDetail.distanceToAsk)}
                />
                <MetricCell
                  label="Queue ahead"
                  value={formatShares(liveDetail.queueAheadShares)}
                />
                <MetricCell
                  label="Queue ahead notional"
                  value={formatMoney(liveDetail.queueAheadNotional)}
                />
                <MetricCell
                  label="Queue x"
                  value={formatMultiple(liveDetail.queueMultiple)}
                />
                <MetricCell
                  label="Qualifying depth"
                  value={formatShares(liveDetail.qualifyingDepthShares)}
                />
              </div>
            </Card>

            <Card className="detail-card">
              <h3>Estimated rewards</h3>
              <div className="detail-grid">
                <MetricCell
                  label="APR ceiling"
                  value={formatPercent(liveDetail.aprCeiling)}
                />
                <MetricCell label="Raw APR" value={formatPercent(liveDetail.rawApr)} />
                <MetricCell
                  label="Eff APR (1-sided)"
                  value={formatPercent(liveDetail.effectiveApr)}
                />
                <MetricCell
                  label="Eff APR (2-sided)"
                  value={formatPercent(liveDetail.twoSidedApr)}
                />
                <MetricCell
                  label="Pricing zone"
                  value={liveDetail.pricingZone ? humanize(liveDetail.pricingZone) : "-"}
                />
                <MetricCell
                  label="Live status"
                  value={humanize(liveDetail.status)}
                />
                <MetricCell
                  label="Live reason"
                  value={humanize(liveDetail.reason)}
                />
              </div>
            </Card>
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
  displayedTwoSidedApr,
  timeToStart,
  expanded,
  onToggle,
  detail,
  detailError,
  detailLoading,
  quoteSizeInput,
  onQuoteSizeChange,
  defaultQuoteSize,
  priceHistoryInterval,
  onPriceHistoryIntervalChange
}: {
  row: OpportunityRow;
  displayedApr: number | null;
  displayedTwoSidedApr: number | null;
  timeToStart: string;
  expanded: boolean;
  onToggle: () => void;
  detail: OpportunityDetailPayload | null;
  detailError: string | null;
  detailLoading: boolean;
  quoteSizeInput: string;
  onQuoteSizeChange: (value: string) => void;
  defaultQuoteSize: number;
  priceHistoryInterval: PriceHistoryInterval;
  onPriceHistoryIntervalChange: (interval: PriceHistoryInterval) => void;
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
    <Card className="market-row">
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
              <Badge key={`${row.marketId}-${tag}`} tone="green">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <div className="market-metrics scanner-metrics">
          <MetricCell label="Eff APR (1-sided)" value={formatPercent(displayedApr)} />
          <MetricCell label="Eff APR (2-sided)" value={formatPercent(displayedTwoSidedApr)} />
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
          <Button
            className={expanded ? "detail-button active" : "detail-button"}
            onClick={onToggle}
            type="button"
            variant={expanded ? "secondary" : "default"}
          >
            <Activity size={16} />
            {expanded ? "Hide LP details" : "LP details"}
          </Button>
          {row.marketUrl ? (
            <a
              className="market-open-link"
              href={row.marketUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink size={15} />
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
            priceHistoryInterval={priceHistoryInterval}
            onPriceHistoryIntervalChange={onPriceHistoryIntervalChange}
          />
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

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [quoteSizeInput, setQuoteSizeInput] = useState("");
  const [priceHistoryInterval, setPriceHistoryInterval] =
    useState<PriceHistoryInterval>("6h");
  const [detailState, setDetailState] = useState<DetailState>({
    key: null,
    loading: false,
    error: null,
    data: null
  });

  useEffect(() => {
    setScannerSort("effectiveApr");
    setExpandedKey(null);
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
  const defaultQuoteSize = meta?.quoteSizeUsdc ?? 1000;
  const parsedQuoteSize = parsePositiveNumber(quoteSizeInput) ?? defaultQuoteSize;
  const isStale = meta?.snapshotHealth === "stale";
  const hasAnyData =
    (scanner?.neutral.rows.length ?? 0) > 0 ||
    (scanner?.extreme.rows.length ?? 0) > 0;
  const visibleTags = useMemo(
    () =>
      Array.from(new Set(activeScannerRows.flatMap((row) => row.tags))).sort((left, right) =>
        left.localeCompare(right)
      ),
    [activeScannerRows]
  );

  useEffect(() => {
    if (scannerTag && !visibleTags.includes(scannerTag)) {
      setScannerTag("");
    }
  }, [scannerTag, visibleTags]);

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
        const displayedApr = row.effectiveApr;
        if ((displayedApr ?? Number.NEGATIVE_INFINITY) < minAprValue) {
          return false;
        }
      }

      return true;
    });

    rows.sort((left, right) => {
      switch (scannerSort) {
        case "twoSidedApr":
          return (
            compareNullableDesc(left.twoSidedApr, right.twoSidedApr) ||
            compareNullableDesc(left.effectiveApr, right.effectiveApr) ||
            right.rewardDailyRate - left.rewardDailyRate
          );
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
            compareNullableDesc(left.twoSidedApr, right.twoSidedApr) ||
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
    showExtreme
  ]);

  useEffect(() => {
    if (
      expandedKey &&
      !filteredScannerRows.some((row) => rowKey(row) === expandedKey)
    ) {
      setExpandedKey(null);
      setDetailState({ key: null, loading: false, error: null, data: null });
    }
  }, [expandedKey, filteredScannerRows]);

  const expandedRow =
    expandedKey === null
      ? null
      : filteredScannerRows.find((row) => rowKey(row) === expandedKey) ??
        null;

  useEffect(() => {
    if (!expandedRow || !meta) {
      setDetailState({ key: null, loading: false, error: null, data: null });
      return;
    }

    const requestKey = rowKey(expandedRow);
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
  }, [expandedRow, meta, parsedQuoteSize, priceHistoryInterval]);

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
            <span>Tag</span>
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

          <label className="control">
            <span>Min APR</span>
            <Input
              inputMode="decimal"
              value={minApr}
              onChange={(event) => setMinApr(event.target.value)}
              placeholder="0"
            />
          </label>

          <label className="control">
            <span>Sort</span>
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

          <label className="control control-select">
            <span>Rows</span>
            <Select
              value={scannerRows}
              onChange={(event) => setScannerRows(Number(event.target.value))}
            >
              <option value={20}>20</option>
              <option value={40}>40</option>
              <option value={80}>80</option>
              <option value={120}>120</option>
            </Select>
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
            <span>Zone</span>
            <FilterToggle
              label="Neutral"
              value="neutral"
              active={!showExtreme}
              onClick={() => setShowExtreme(false)}
            />
            <FilterToggle
              label="Extreme"
              value="extreme"
              active={showExtreme}
              onClick={() => setShowExtreme(true)}
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
          const key = rowKey(row);
          const expanded = expandedKey === key;
          return (
            <ScannerRowCard
              key={key}
              row={row}
              displayedApr={row.effectiveApr}
              displayedTwoSidedApr={row.twoSidedApr}
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
              priceHistoryInterval={priceHistoryInterval}
              onPriceHistoryIntervalChange={setPriceHistoryInterval}
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
