import type { ProviderSnapshot, TrendSummary } from "../types.js";

const blocks = "▁▂▃▄▅▆▇█";

function primaryValue(snapshot: ProviderSnapshot): { key: string; value: number } | undefined {
  const window = snapshot.windows.find((item) => item.usedPercent !== undefined);
  if (window?.usedPercent !== undefined) {
    return { key: `window:${window.id}`, value: window.usedPercent };
  }
  const preferred = ["cost", "tokens", "sessions", "messages"];
  for (const key of preferred) {
    const metric = snapshot.metrics.find(
      (item) => item.key.includes(key) && typeof item.value === "number",
    );
    if (metric && typeof metric.value === "number") {
      return { key: metric.key, value: metric.value };
    }
  }
  return undefined;
}

function valueFor(snapshot: ProviderSnapshot, key: string): number | undefined {
  if (key.startsWith("window:")) {
    return snapshot.windows.find((item) => item.id === key.slice(7))?.usedPercent;
  }
  const metric = snapshot.metrics.find((item) => item.key === key);
  return typeof metric?.value === "number" ? metric.value : undefined;
}

function deltaAt(
  history: ProviderSnapshot[],
  key: string,
  currentValue: number,
  targetMs: number,
): number | undefined {
  if (history.length === 0) return undefined;
  const currentTime = Date.parse(history.at(-1)?.collectedAt ?? new Date().toISOString());
  const target = currentTime - targetMs;
  let closest: ProviderSnapshot | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const snapshot of history) {
    const distance = Math.abs(Date.parse(snapshot.collectedAt) - target);
    if (distance < closestDistance) {
      closest = snapshot;
      closestDistance = distance;
    }
  }
  const prior = closest ? valueFor(closest, key) : undefined;
  return prior === undefined ? undefined : currentValue - prior;
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return blocks[0]?.repeat(Math.min(values.length, 16)) ?? "";
  return values
    .slice(-16)
    .map((value) => blocks[Math.round(((value - min) / (max - min)) * (blocks.length - 1))])
    .join("");
}

export function computeTrend(history: ProviderSnapshot[]): TrendSummary {
  const current = history.at(-1);
  if (!current) return {};
  const primary = primaryValue(current);
  if (!primary) return {};
  const values = history
    .map((item) => valueFor(item, primary.key))
    .filter((value): value is number => value !== undefined);
  let estimatedTimeToLimitSec: number | undefined;
  if (primary.key.startsWith("window:")) {
    const comparable = history
      .map((snapshot) => ({
        at: Date.parse(snapshot.collectedAt),
        value: valueFor(snapshot, primary.key),
        resetsAt: snapshot.windows.find((item) => `window:${item.id}` === primary.key)?.resetsAt,
      }))
      .filter(
        (item): item is { at: number; value: number; resetsAt: string | null | undefined } =>
          Number.isFinite(item.at) && item.value !== undefined,
      );
    const first = comparable[0];
    const last = comparable.at(-1);
    const spansTenMinutes =
      first !== undefined && last !== undefined && last.at - first.at >= 10 * 60 * 1000;
    const sameWindow =
      first?.resetsAt === last?.resetsAt ||
      (first?.resetsAt === undefined && last?.resetsAt === undefined);
    const monotonic = comparable.every(
      (item, index) => index === 0 || item.value >= (comparable[index - 1]?.value ?? item.value),
    );
    if (first && last && comparable.length >= 3 && spansTenMinutes && sameWindow && monotonic) {
      const consumed = last.value - first.value;
      const elapsedSeconds = (last.at - first.at) / 1000;
      if (consumed > 0 && last.value < 100) {
        estimatedTimeToLimitSec = ((100 - last.value) / consumed) * elapsedSeconds;
      }
    }
  }
  return {
    metricKey: primary.key,
    delta1h: deltaAt(history, primary.key, primary.value, 3_600_000),
    delta24h: deltaAt(history, primary.key, primary.value, 86_400_000),
    delta7d: deltaAt(history, primary.key, primary.value, 604_800_000),
    sparkline: sparkline(values),
    ...(estimatedTimeToLimitSec === undefined ? {} : { estimatedTimeToLimitSec }),
  };
}
