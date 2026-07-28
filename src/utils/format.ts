import type { Metric, ProviderSnapshot, UsageWindow } from "../types.js";

export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: Math.abs(value) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatMetric(metric: Metric): string {
  if (metric.value === null) return "—";
  if (typeof metric.value === "string") return metric.value;
  switch (metric.unit) {
    case "percent":
      return `${metric.value.toFixed(0)}%`;
    case "currency":
      return `$${metric.value.toFixed(2)}`;
    case "tokens":
      return compactNumber(metric.value);
    case "duration":
      return formatDuration(metric.value);
    case "timestamp":
      return new Date(metric.value).toLocaleString();
    default:
      return compactNumber(metric.value);
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function remainingPercent(usedPercent: number): number {
  return 100 - Math.max(0, Math.min(100, usedPercent));
}

export function formatWindowUsage(window: UsageWindow, fractionDigits = 0): string {
  if (window.usedPercent === undefined) return "—";
  if (window.category === "additional") {
    return `${window.usedPercent.toFixed(fractionDigits)}% used`;
  }
  return `${remainingPercent(window.usedPercent).toFixed(fractionDigits)}% left`;
}

export function remainingSparkline(value: string): string {
  const blocks = "▁▂▃▄▅▆▇█";
  return [...value]
    .map((block) => {
      const index = blocks.indexOf(block);
      return index < 0 ? block : blocks[blocks.length - index - 1];
    })
    .join("");
}

export function resetLabel(window: UsageWindow | undefined, now = Date.now()): string {
  if (!window) return "—";
  if (window.resetsAt) {
    const delta = Date.parse(window.resetsAt) - now;
    if (delta <= 0) return "reset due";
    return `in ${formatDuration(delta / 1000)}`;
  }
  return window.resetDescription ?? "—";
}

export function resetDetailLabel(window: UsageWindow, now = Date.now()): string {
  const countdown = resetLabel(window, now);
  if (
    window.resetsAt &&
    window.resetDescription &&
    countdown !== window.resetDescription
  ) {
    return `${countdown} · ${window.resetDescription}`;
  }
  return countdown;
}

export function primaryUsage(snapshot: ProviderSnapshot): string {
  const window = snapshot.windows.find((item) => item.usedPercent !== undefined);
  if (window?.usedPercent !== undefined) return formatWindowUsage(window);
  const metric =
    snapshot.metrics.find((item) => item.key.includes("cost")) ??
    snapshot.metrics.find((item) => item.key === "tokens") ??
    snapshot.metrics[0];
  return metric ? `${formatMetric(metric)}${metric.period ? `/${metric.period}` : ""}` : "—";
}

export function includedUsage(snapshot: ProviderSnapshot): string {
  const window = snapshot.windows.find(
    (item) => item.category !== "additional" && item.usedPercent !== undefined,
  );
  return window?.usedPercent === undefined ? "—" : formatWindowUsage(window);
}

export type UsagePeriod = "current" | "weekly" | "monthly";

function usagePeriod(window: UsageWindow): UsagePeriod {
  const identity = `${window.id} ${window.label} ${window.resetDescription ?? ""}`.toLowerCase();
  if (/month|billing|included/.test(identity)) return "monthly";
  if (/week|7[\s-]*day|10080\s+minute/.test(identity)) return "weekly";
  const days = Number(identity.match(/(\d+)[\s-]*day/)?.[1]);
  if (Number.isFinite(days)) {
    if (days >= 21) return "monthly";
    if (days >= 6) return "weekly";
  }
  const minutes = Number(identity.match(/(\d+)\s+minute\s+window/)?.[1]);
  if (Number.isFinite(minutes)) {
    if (minutes >= 21 * 24 * 60) return "monthly";
    if (minutes >= 6 * 24 * 60) return "weekly";
  }
  return "current";
}

export function usageWindowsForPeriod(
  snapshot: ProviderSnapshot,
  period: UsagePeriod,
): UsageWindow[] {
  return snapshot.windows.filter(
    (window) =>
      window.category !== "additional" &&
      window.usedPercent !== undefined &&
      usagePeriod(window) === period,
  );
}

function primaryPeriodWindow(windows: UsageWindow[]): UsageWindow | undefined {
  return windows.reduce<UsageWindow | undefined>((highest, window) => {
    if (!highest) return window;
    return (window.usedPercent ?? -1) > (highest.usedPercent ?? -1) ? window : highest;
  }, undefined);
}

export function periodConsumed(snapshot: ProviderSnapshot, period: UsagePeriod): string {
  const windows = usageWindowsForPeriod(snapshot, period);
  const primary = primaryPeriodWindow(windows);
  if (primary?.usedPercent === undefined) return "—";
  const consumed = `${primary.usedPercent.toFixed(0)}%`;
  return windows.length > 1 ? `${consumed} +${windows.length - 1}` : consumed;
}

export function periodReset(
  snapshot: ProviderSnapshot,
  period: UsagePeriod,
  now = Date.now(),
): string {
  const windows = usageWindowsForPeriod(snapshot, period);
  const primary = primaryPeriodWindow(windows);
  const withReset =
    primary?.resetsAt || primary?.resetDescription
      ? primary
      : windows.find((window) => window.resetsAt || window.resetDescription);
  return resetLabel(withReset, now);
}

export function additionalOrLocalUsage(snapshot: ProviderSnapshot): string {
  const additional = snapshot.metrics.filter((metric) => metric.category === "additional");
  const additionalMetric =
    additional.find((metric) => metric.key.includes("balance")) ??
    additional.find((metric) => metric.key.includes("spent")) ??
    additional.find((metric) => metric.key.includes("status")) ??
    additional[0];
  if (additionalMetric) {
    const value = formatMetric(additionalMetric);
    if (additionalMetric.key.includes("balance")) return `${value} left`;
    if (additionalMetric.key.includes("spent")) return `${value} spent`;
    if (additionalMetric.key.includes("status")) {
      const label = additionalMetric.label.toLowerCase().replace(/^usage\s+/, "");
      return `${label} ${value}`;
    }
    return value;
  }
  const additionalWindow = snapshot.windows.find(
    (window) => window.category === "additional" && window.usedPercent !== undefined,
  );
  if (additionalWindow?.usedPercent !== undefined) {
    return formatWindowUsage(additionalWindow);
  }

  const local = snapshot.metrics.filter(
    (metric) => metric.category === "local" || metric.category === undefined,
  );
  const localMetric =
    local.find((metric) => metric.key === "estimated_cost") ??
    local.find((metric) => metric.key === "tokens") ??
    local.find((metric) => metric.key === "sessions") ??
    local[0];
  if (!localMetric) return "—";
  const value = `${formatMetric(localMetric)}${localMetric.period ? `/${localMetric.period}` : ""}`;
  return localMetric.quality === "estimated" ? `~${value} local` : `${value} local`;
}

export function truncate(value: string, length: number): string {
  if (length <= 1) return value.slice(0, Math.max(length, 0));
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
