import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { MonitorConfig } from "../config.js";
import type { MonitorEngine } from "../core/engine.js";
import type { HistoryStore } from "../core/history.js";
import { computeTrend } from "../core/trends.js";
import {
  dashboardAuthInstruction,
  dashboardProviderLabel,
  dashboardProviders,
  type DashboardAuthMode,
  type DashboardProvider,
} from "../dashboard-auth.js";
import {
  providerIds,
  type Metric,
  type MonitorState,
  type ProviderId,
  type ProviderSnapshot,
  type UsageWindow,
} from "../types.js";
import {
  compactNumber,
  formatDuration,
  formatMetric,
  formatWindowUsage,
  primaryUsage,
  remainingPercent,
  remainingSparkline,
  resetDetailLabel,
  resetLabel,
  truncate,
} from "../utils/format.js";

interface AppProps {
  engine: MonitorEngine;
  config: MonitorConfig;
  history?: HistoryStore;
  authenticateProvider?: (
    provider: DashboardProvider,
    mode?: DashboardAuthMode,
    signal?: AbortSignal,
  ) => Promise<string>;
}

interface AuthState {
  provider?: DashboardProvider;
  mode?: DashboardAuthMode;
  status: "working" | "success" | "error" | "unsupported";
  message: string;
}

const emptyState: MonitorState = {
  snapshots: new Map(),
  refreshing: new Set(),
  paused: false,
};

function statusGlyph(status: ProviderSnapshot["status"] | "loading"): string {
  switch (status) {
    case "ok":
      return "●";
    case "partial":
      return "◐";
    case "stale":
      return "◷";
    case "unavailable":
      return "○";
    case "error":
      return "×";
    default:
      return "·";
  }
}

function statusColor(status: ProviderSnapshot["status"] | "loading"): string {
  switch (status) {
    case "ok":
      return "green";
    case "partial":
    case "stale":
      return "yellow";
    case "error":
      return "red";
    case "unavailable":
      return "gray";
    default:
      return "cyan";
  }
}

function usageColor(usedPercent: number | undefined, config: MonitorConfig): string {
  if (usedPercent === undefined) return "gray";
  if (usedPercent >= config.criticalPercent) return "red";
  if (usedPercent >= config.warningPercent) return "yellow";
  return "green";
}

function useTrend(
  snapshot: ProviderSnapshot | undefined,
  history: HistoryStore | undefined,
): ReturnType<typeof computeTrend> {
  return useMemo(() => {
    if (!snapshot || !history) return {};
    const since = new Date(Date.now() - 7 * 86_400_000);
    const recent = history.recent(snapshot.providerId, since);
    if (recent.at(-1)?.collectedAt !== snapshot.collectedAt) recent.push(snapshot);
    return computeTrend(recent);
  }, [snapshot, history]);
}

function trendUsesRemaining(snapshot: ProviderSnapshot | undefined, metricKey?: string): boolean {
  if (!snapshot || !metricKey?.startsWith("window:")) return false;
  const window = snapshot.windows.find((item) => item.id === metricKey.slice(7));
  return window !== undefined && window.category !== "additional";
}

function WindowGauge({
  window,
  config,
  now,
  compact,
}: {
  window: UsageWindow;
  config: MonitorConfig;
  now: number;
  compact: boolean;
}) {
  const usedPercent = window.usedPercent;
  const percent =
    usedPercent === undefined
      ? undefined
      : window.category === "additional"
        ? usedPercent
        : remainingPercent(usedPercent);
  const barWidth = compact ? 8 : 12;
  const filled =
    percent === undefined
      ? 0
      : Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)));
  const color = usageColor(usedPercent, config);
  const reset = resetLabel(window, now);
  return (
    <Box marginRight={2}>
      <Text>{truncate(window.label, compact ? 14 : 18)} </Text>
      <Text color={color}>
        {"█".repeat(filled)}
        <Text color="gray">{"░".repeat(barWidth - filled)}</Text>
      </Text>
      <Text bold color={color}>
        {" "}{percent === undefined ? "—" : formatWindowUsage(window)}
      </Text>
      {reset === "—" ? null : <Text color="gray"> · {reset}</Text>}
    </Box>
  );
}

function metricPriority(metric: Metric, category: "additional" | "local"): number {
  const key = metric.key.toLowerCase();
  const order =
    category === "additional"
      ? ["balance", "spent", "limit", "status"]
      : ["estimated_cost", "sessions", "messages", "tokens", "input", "output"];
  const index = order.findIndex((value) => key.includes(value));
  return index < 0 ? order.length : index;
}

function metricSummary(metrics: Metric[], category: "additional" | "local", max: number): string {
  return [...metrics]
    .sort((a, b) => metricPriority(a, category) - metricPriority(b, category))
    .slice(0, max)
    .map((metric) => {
      const estimate = metric.quality === "estimated" ? "~" : "";
      return `${metric.label} ${estimate}${formatMetric(metric)}${
        metric.period ? `/${metric.period}` : ""
      }`;
    })
    .join(" · ");
}

function ProviderSection({
  snapshot,
  selected,
  refreshing,
  config,
  history,
  width,
  now,
}: {
  snapshot: ProviderSnapshot | undefined;
  selected: boolean;
  refreshing: boolean;
  config: MonitorConfig;
  history?: HistoryStore;
  width: number;
  now: number;
}) {
  const trend = useTrend(snapshot, history);
  const name = snapshot?.providerName ?? "Loading";
  const status = snapshot?.status ?? "loading";
  const plan = snapshot?.plan ?? "—";
  const compact = width < 100;
  const planWindows =
    snapshot?.windows.filter((window) => window.category !== "additional") ?? [];
  const additionalWindows =
    snapshot?.windows.filter((window) => window.category === "additional") ?? [];
  const additionalMetrics =
    snapshot?.metrics.filter((metric) => metric.category === "additional") ?? [];
  const localMetrics =
    snapshot?.metrics.filter(
      (metric) => metric.category === "local" || metric.category === undefined,
    ) ?? [];
  const updated = snapshot
    ? new Date(snapshot.collectedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "starting";
  const trendText =
    trend.delta24h === undefined
      ? ""
      : (() => {
          const delta = trendUsesRemaining(snapshot, trend.metricKey)
            ? -trend.delta24h
            : trend.delta24h;
          return `24h ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
        })();
  const additionalText = metricSummary(additionalMetrics, "additional", compact ? 2 : 4);
  const showLocal =
    planWindows.length === 0 ||
    snapshot?.providerId === "opencode" ||
    snapshot?.providerId === "gemini";
  const localText = showLocal
    ? metricSummary(localMetrics, "local", compact ? 2 : 4)
    : "";
  return (
    <Box
      borderStyle="round"
      borderColor={selected ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      <Box justifyContent="space-between">
        <Text bold>
          {selected ? "› " : "  "}
          <Text color={statusColor(status)}>
            {statusGlyph(status)}{refreshing ? "↻" : " "}
          </Text>{" "}
          {name}
          {plan === "—" ? null : <Text color="gray"> · {plan}</Text>}
        </Text>
        <Text color={refreshing ? "cyan" : "gray"}>
          {refreshing ? "LIVE ↻" : `updated ${updated}`}
          {trendText ? ` · ${trendText}` : ""}
        </Text>
      </Box>
      {!snapshot ? <Text color="gray">Collecting live usage…</Text> : null}
      {planWindows.length > 0 ? (
        <Box flexWrap="wrap">
          <Text bold color="cyan">Plan  </Text>
          {planWindows.map((window) => (
            <WindowGauge
              key={window.id}
              window={window}
              config={config}
              now={now}
              compact={compact}
            />
          ))}
        </Box>
      ) : null}
      {additionalWindows.length > 0 ? (
        <Box flexWrap="wrap">
          <Text bold color="cyan">Extra </Text>
          {additionalWindows.map((window) => (
            <WindowGauge
              key={window.id}
              window={window}
              config={config}
              now={now}
              compact={compact}
            />
          ))}
        </Box>
      ) : null}
      {additionalText ? (
        <Text>
          <Text bold color="cyan">Extra </Text>
          {additionalText}
        </Text>
      ) : null}
      {localText ? (
        <Text>
          <Text bold color="cyan">Local </Text>
          {localText}
        </Text>
      ) : null}
      {snapshot && planWindows.length === 0 && additionalWindows.length === 0 &&
      !additionalText && !localText ? (
        <Text>{snapshot.summary}</Text>
      ) : null}
      {snapshot?.message ? (
        <Text color={snapshot.status === "error" ? "red" : "yellow"}>
          {truncate(snapshot.message, Math.max(20, width - 6))}
        </Text>
      ) : null}
    </Box>
  );
}

function DetailPanel({
  snapshot,
  history,
  width,
  now,
}: {
  snapshot: ProviderSnapshot | undefined;
  history?: HistoryStore;
  width: number;
  now: number;
}) {
  const trend = useTrend(snapshot, history);
  if (!snapshot) {
    return (
      <Box borderStyle="round" paddingX={1} width={width}>
        <Text color="gray">Waiting for provider data…</Text>
      </Box>
    );
  }
  const additionalMetrics = snapshot.metrics.filter(
    (metric) => metric.category === "additional",
  );
  const includedWindows = snapshot.windows.filter(
    (window) => window.category !== "additional",
  );
  const additionalWindows = snapshot.windows.filter(
    (window) => window.category === "additional",
  );
  const localMetrics = snapshot.metrics.filter(
    (metric) => metric.category === "local" || metric.category === undefined,
  );
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Text bold>
        {snapshot.providerName} <Text color="gray">via {snapshot.source}</Text>
      </Text>
      <Text>
        {snapshot.windows.some((window) => window.usedPercent !== undefined)
          ? primaryUsage(snapshot)
          : snapshot.summary}
      </Text>
      {includedWindows.length > 0 ? <Text bold color="cyan">Plan limits</Text> : null}
      {includedWindows.map((window) => (
        <Text key={window.id}>
          {window.label.padEnd(18)}{" "}
          <Text color={window.quality === "exact" ? "white" : "yellow"}>
            {formatWindowUsage(window, 1)}
          </Text>{" "}
          <Text color="gray">{resetDetailLabel(window, now)}</Text>
        </Text>
      ))}
      {additionalWindows.length > 0 || additionalMetrics.length > 0 ? (
        <Text bold color="cyan">Additional usage</Text>
      ) : null}
      {additionalWindows.map((window) => (
        <Text key={window.id}>
          {window.label.padEnd(18)}{" "}
          <Text color={window.quality === "exact" ? "white" : "yellow"}>
            {formatWindowUsage(window, 1)}
          </Text>{" "}
          <Text color="gray">{resetDetailLabel(window, now)}</Text>
        </Text>
      ))}
      {additionalMetrics.slice(0, 6).map((metric) => (
        <Text key={metric.key}>
          {metric.label.padEnd(18)} {formatMetric(metric)}{" "}
          <Text color={metric.quality === "exact" ? "gray" : "yellow"}>
            {metric.quality === "exact" ? "" : `(${metric.quality})`}
          </Text>
        </Text>
      ))}
      {localMetrics.length > 0 ? <Text bold color="cyan">Local activity</Text> : null}
      {localMetrics.slice(0, 6).map((metric) => (
        <Text key={metric.key}>
          {metric.label.padEnd(18)} {formatMetric(metric)}{" "}
          <Text color={metric.quality === "exact" ? "gray" : "yellow"}>
            {metric.quality === "exact" ? "" : `(${metric.quality})`}
          </Text>
        </Text>
      ))}
      {trend.sparkline ? (
        <Text>
          7-day history      <Text color="cyan">
            {trendUsesRemaining(snapshot, trend.metricKey)
              ? remainingSparkline(trend.sparkline)
              : trend.sparkline}
          </Text>
        </Text>
      ) : null}
      {trend.estimatedTimeToLimitSec !== undefined ? (
        <Text color="yellow">
          Estimated limit    in {formatDuration(trend.estimatedTimeToLimitSec)}
        </Text>
      ) : null}
      {snapshot.message ? <Text color={snapshot.status === "error" ? "red" : "yellow"}>{snapshot.message}</Text> : null}
      <Text color="gray">
        Updated {new Date(snapshot.collectedAt).toLocaleTimeString()} · {snapshot.version ?? "version unknown"}
      </Text>
    </Box>
  );
}

function HelpPanel({ width }: { width: number }) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Text bold>Keyboard</Text>
      <Text>↑/↓ or j/k select provider · Enter toggle details · r refresh</Text>
      <Text>a isolated auth · A personal Chrome · Space pause/resume · h close help · q quit</Text>
      <Text color="gray">No credentials, prompts, transcripts, or raw terminal screens are persisted.</Text>
    </Box>
  );
}

function AuthPanel({ state, width }: { state: AuthState; width: number }) {
  const color =
    state.status === "success"
      ? "green"
      : state.status === "error" || state.status === "unsupported"
        ? "yellow"
        : "cyan";
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Text bold color={color}>
        {state.status === "working"
          ? `Authenticating ${state.provider ? dashboardProviderLabel(state.provider) : "provider"}${
              state.mode === "personal" ? " in personal Chrome" : ""
            }…`
          : state.status === "success"
            ? "Dashboard connected"
            : "Dashboard authentication"}
      </Text>
      <Text>{state.message}</Text>
      <Text color="gray">
        {state.status === "working"
          ? state.mode === "personal"
            ? "Keep the usage tab open; the monitor resumes when it can read it. Press q or Esc to cancel."
            : "The monitor resumes after Chrome closes. Press q or Esc to cancel."
          : "Press Enter to return to provider details."}
      </Text>
    </Box>
  );
}

export function App({ engine, config, history, authenticateProvider }: AppProps) {
  const { exit } = useApp();
  const { columns: terminalColumns } = useWindowSize();
  const [state, setState] = useState<MonitorState>(emptyState);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [authState, setAuthState] = useState<AuthState>();
  const authController = useRef<AbortController | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const enabledIds = providerIds.filter((id) => config.enabledProviders.includes(id));
  const layoutWidth = Math.min(Math.max(terminalColumns, 60), 180);

  useEffect(() => engine.subscribe(setState), [engine]);
  useEffect(() => () => authController.current?.abort(), []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    timer.unref();
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    if (authState?.status === "working") {
      if (input === "q" || key.escape) {
        authController.current?.abort();
        setAuthState({
          provider: authState.provider,
          mode: authState.mode,
          status: "error",
          message: "Dashboard authentication cancelled",
        });
      }
      return;
    }
    if (input === "q") {
      exit();
    } else if (authState && key.return) {
      setAuthState(undefined);
    } else if (input === "h") {
      setAuthState(undefined);
      setShowHelp((value) => !value);
    } else if (input === "r") {
      void engine.refreshAll();
    } else if (input === "a" || input === "A") {
      if (!selectedId || !dashboardProviders.includes(selectedId as DashboardProvider)) {
        setAuthState({
          status: "unsupported",
          message: "Dashboard authentication is available for Claude Code, Cursor, and OpenCode.",
        });
      } else if (!authenticateProvider) {
        setAuthState({
          status: "error",
          message: "Interactive dashboard authentication is unavailable in this session.",
        });
      } else {
        const provider = selectedId as DashboardProvider;
        const mode: DashboardAuthMode = input === "A" ? "personal" : "isolated";
        const controller = new AbortController();
        authController.current = controller;
        setShowHelp(false);
        setAuthState({
          provider,
          mode,
          status: "working",
          message: dashboardAuthInstruction(provider, mode),
        });
        void authenticateProvider(provider, mode, controller.signal)
          .then((url) => {
            setAuthState({
              provider,
              mode,
              status: "success",
              message: `${dashboardProviderLabel(provider)} connected at ${new URL(url).hostname} using ${
                mode === "personal" ? "personal Chrome" : "an isolated profile"
              }. Usage is refreshing now.`,
            });
          })
          .catch((error: unknown) => {
            setAuthState({
              provider,
              mode,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            if (authController.current === controller) authController.current = undefined;
          });
      }
    } else if (input === " ") {
      engine.togglePaused();
    } else if (key.return) {
      setShowDetails((value) => !value);
    } else if (key.upArrow || input === "k") {
      setAuthState(undefined);
      setSelectedIndex((index) => (index - 1 + enabledIds.length) % enabledIds.length);
    } else if (key.downArrow || input === "j") {
      setAuthState(undefined);
      setSelectedIndex((index) => (index + 1) % enabledIds.length);
    }
  });

  const selectedId = enabledIds[selectedIndex] as ProviderId | undefined;
  const selectedSnapshot = selectedId ? state.snapshots.get(selectedId) : undefined;
  const okCount = [...state.snapshots.values()].filter((item) => item.status === "ok").length;
  const partialCount = [...state.snapshots.values()].filter(
    (item) => item.status === "partial" || item.status === "stale",
  ).length;
  const lastUpdate = [...state.snapshots.values()]
    .map((item) => Date.parse(item.collectedAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          agent-monitor
        </Text>
        <Text color={state.paused ? "yellow" : "gray"}>
          {state.paused
            ? "PAUSED"
            : `LIVE · ${okCount} healthy${partialCount ? ` · ${partialCount} partial` : ""}`}{" "}
          ·{" "}
          {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "starting"}
        </Text>
      </Box>
      {enabledIds.map((id, index) => (
        <ProviderSection
          key={id}
          snapshot={state.snapshots.get(id)}
          selected={index === selectedIndex}
          refreshing={state.refreshing.has(id)}
          config={config}
          history={history}
          width={layoutWidth}
          now={now}
        />
      ))}
      <Box marginTop={1}>
        {authState ? (
          <AuthPanel state={authState} width={layoutWidth} />
        ) : showHelp ? (
          <HelpPanel width={layoutWidth} />
        ) : showDetails ? (
          <DetailPanel
            snapshot={selectedSnapshot}
            history={history}
            width={layoutWidth}
            now={now}
          />
        ) : (
          <Text color="gray">
            Enter for details · a/A auth · r refresh · Space pause · h help · q quit ·{" "}
            {compactNumber(state.refreshing.size)} refreshing
          </Text>
        )}
      </Box>
    </Box>
  );
}
