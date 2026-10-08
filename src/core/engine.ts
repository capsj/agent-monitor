import type { MonitorConfig } from "../config.js";
import {
  errorSnapshot,
  snapshotKey,
  type MonitorState,
  type ProviderAdapter,
  type ProviderSnapshot,
} from "../types.js";
import type { HistoryStore } from "./history.js";

type Listener = (state: MonitorState) => void;

export function adapterKey(adapter: Pick<ProviderAdapter, "id" | "accountId">): string {
  return snapshotKey({ providerId: adapter.id, accountId: adapter.accountId });
}

function fallbackSource(adapter: ProviderAdapter): ProviderSnapshot["source"] {
  switch (adapter.id) {
    case "codex":
      return "structured";
    case "claude":
    case "cursor":
      return "api";
    case "opencode":
    case "gemini":
      return "local";
  }
}

export class MonitorEngine {
  private readonly snapshots = new Map<string, ProviderSnapshot>();
  private readonly refreshing = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failures = new Map<string, number>();
  private stopped = true;
  private paused = false;

  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly config: MonitorConfig,
    private readonly history?: HistoryStore,
  ) {}

  /** Snapshot keys in display order. */
  keys(): string[] {
    return this.adapters.map(adapterKey);
  }

  getState(): MonitorState {
    return {
      snapshots: new Map(this.snapshots),
      refreshing: new Set(this.refreshing),
      paused: this.paused,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await Promise.allSettled(this.adapters.map((adapter) => this.collect(adapterKey(adapter))));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.adapters.map((adapter) => adapter.stop?.()));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.emit();
    if (!paused) {
      void this.refreshAll();
    }
  }

  togglePaused(): void {
    this.setPaused(!this.paused);
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      this.adapters.map((adapter) => this.collect(adapterKey(adapter), true)),
    );
  }

  async collect(key: string, manual = false): Promise<void> {
    if (this.stopped || this.paused || this.refreshing.has(key)) return;
    const adapter = this.adapters.find((item) => adapterKey(item) === key);
    if (!adapter) return;
    const oldTimer = this.timers.get(key);
    if (oldTimer) clearTimeout(oldTimer);

    this.refreshing.add(key);
    this.emit();
    let failed = false;
    try {
      const collected = await adapter.collect({
        reason: manual ? "manual" : "scheduled",
        force: manual,
      });
      failed = collected.status === "error";
      const snapshot = failed
        ? this.staleOrError(key, collected)
        : this.preservePreviousOnPartial(key, collected);
      failed ||= snapshot.status === "stale";
      this.snapshots.set(key, snapshot);
      if (snapshot.status !== "stale") this.history?.record(snapshot);
    } catch (error) {
      failed = true;
      const failure = errorSnapshot(adapter, fallbackSource(adapter), error);
      const snapshot = this.staleOrError(key, failure);
      this.snapshots.set(key, snapshot);
      if (snapshot.status !== "stale") this.history?.record(snapshot);
    } finally {
      this.refreshing.delete(key);
      const failureCount = failed ? (this.failures.get(key) ?? 0) + 1 : 0;
      this.failures.set(key, failureCount);
      this.emit();
      if (!this.stopped) {
        const base = adapter.defaultRefreshMs;
        const delay = manual || !failed ? base : Math.min(base * 2 ** failureCount, 300_000);
        const timer = setTimeout(() => void this.collect(key), delay);
        timer.unref();
        this.timers.set(key, timer);
      }
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private staleOrError(key: string, failure: ProviderSnapshot): ProviderSnapshot {
    const previous = this.snapshots.get(key);
    if (!previous || previous.status === "error") return failure;
    return {
      ...previous,
      status: "stale",
      message: `Latest refresh failed: ${failure.message ?? failure.summary}`,
    };
  }

  private preservePreviousOnPartial(
    key: string,
    collected: ProviderSnapshot,
  ): ProviderSnapshot {
    if (collected.status !== "partial") return collected;
    const previous = this.snapshots.get(key);
    if (
      !previous ||
      previous.status === "error" ||
      (previous.windows.length === 0 && previous.metrics.length === 0)
    ) {
      return collected;
    }

    const collectedWindowIds = new Set(collected.windows.map((window) => window.id));
    const collectedMetricKeys = new Set(collected.metrics.map((metric) => metric.key));
    const missingWindows = previous.windows
      .filter((window) => !collectedWindowIds.has(window.id))
      .map((window) => ({ ...window, quality: "stale" as const }));
    const missingMetrics = previous.metrics
      .filter((metric) => !collectedMetricKeys.has(metric.key))
      .map((metric) => ({ ...metric, quality: "stale" as const }));
    if (missingWindows.length === 0 && missingMetrics.length === 0) return collected;

    return {
      ...collected,
      collectedAt: previous.collectedAt,
      status: "stale",
      plan: collected.plan ?? previous.plan,
      version: collected.version ?? previous.version,
      summary: collected.windows.length > 0 || collected.metrics.length > 0
        ? collected.summary
        : previous.summary,
      windows: [...collected.windows, ...missingWindows],
      metrics: [...collected.metrics, ...missingMetrics],
      message: `Latest refresh returned partial data: ${collected.message ?? collected.summary}`,
    };
  }
}
