import type { MonitorConfig } from "../config.js";
import {
  errorSnapshot,
  type MonitorState,
  type ProviderAdapter,
  type ProviderId,
  type ProviderSnapshot,
} from "../types.js";
import type { HistoryStore } from "./history.js";

type Listener = (state: MonitorState) => void;

export class MonitorEngine {
  private readonly snapshots = new Map<ProviderId, ProviderSnapshot>();
  private readonly refreshing = new Set<ProviderId>();
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<ProviderId, NodeJS.Timeout>();
  private readonly failures = new Map<ProviderId, number>();
  private readonly suspended = new Set<ProviderId>();
  private readonly idleWaiters = new Map<ProviderId, Set<() => void>>();
  private stopped = true;
  private paused = false;

  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly config: MonitorConfig,
    private readonly history?: HistoryStore,
  ) {}

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
    await Promise.allSettled(this.adapters.map((adapter) => this.collect(adapter.id)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.adapters.map((adapter) => adapter.stop?.()));
  }

  async suspendProvider(id: ProviderId): Promise<void> {
    this.suspended.add(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (this.refreshing.has(id)) {
      await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolve);
        this.idleWaiters.set(id, waiters);
      });
    }
    const adapter = this.adapters.find((item) => item.id === id);
    await adapter?.stop?.();
  }

  resumeProvider(id: ProviderId): void {
    this.suspended.delete(id);
    void this.collect(id, true);
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
    await Promise.allSettled(this.adapters.map((adapter) => this.collect(adapter.id, true)));
  }

  async collect(id: ProviderId, manual = false): Promise<void> {
    if (this.stopped || this.paused || this.suspended.has(id) || this.refreshing.has(id)) return;
    const adapter = this.adapters.find((item) => item.id === id);
    if (!adapter) return;
    const oldTimer = this.timers.get(id);
    if (oldTimer) clearTimeout(oldTimer);

    this.refreshing.add(id);
    this.emit();
    let failed = false;
    try {
      const collected = await adapter.collect();
      failed = collected.status === "error";
      const snapshot = failed
        ? this.staleOrError(id, collected)
        : this.preservePreviousOnPartial(id, collected);
      failed ||= snapshot.status === "stale";
      this.snapshots.set(id, snapshot);
      if (snapshot.status !== "stale") this.history?.record(snapshot);
    } catch (error) {
      failed = true;
      const failure = errorSnapshot(
        id,
        adapter.name,
        id === "codex" ? "structured" : id === "opencode" || id === "gemini" ? "local" : "cli",
        error,
      );
      const snapshot = this.staleOrError(id, failure);
      this.snapshots.set(id, snapshot);
      if (snapshot.status !== "stale") this.history?.record(snapshot);
    } finally {
      this.refreshing.delete(id);
      const waiters = this.idleWaiters.get(id);
      if (waiters) {
        this.idleWaiters.delete(id);
        for (const resolve of waiters) resolve();
      }
      const failureCount = failed ? (this.failures.get(id) ?? 0) + 1 : 0;
      this.failures.set(id, failureCount);
      this.emit();
      if (!this.stopped && !this.suspended.has(id)) {
        const base = adapter.defaultRefreshMs;
        const delay = manual || !failed ? base : Math.min(base * 2 ** failureCount, 300_000);
        const timer = setTimeout(() => void this.collect(id), delay);
        timer.unref();
        this.timers.set(id, timer);
      }
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private staleOrError(
    id: ProviderId,
    failure: ProviderSnapshot,
  ): ProviderSnapshot {
    const previous = this.snapshots.get(id);
    if (!previous || previous.status === "error") return failure;
    return {
      ...previous,
      status: "stale",
      message: `Latest refresh failed: ${failure.message ?? failure.summary}`,
    };
  }

  private preservePreviousOnPartial(
    id: ProviderId,
    collected: ProviderSnapshot,
  ): ProviderSnapshot {
    if (collected.status !== "partial") return collected;
    const previous = this.snapshots.get(id);
    if (
      !previous ||
      previous.status === "error" ||
      (previous.windows.length === 0 && previous.metrics.length === 0)
    ) {
      return collected;
    }

    const collectedWindowIds = new Set(collected.windows.map((window) => window.id));
    const collectedMetricKeys = new Set(collected.metrics.map((metric) => metric.key));
    const missingWindows = previous.windows.filter(
      (window) => !collectedWindowIds.has(window.id),
    );
    const missingMetrics = previous.metrics.filter(
      (metric) => !collectedMetricKeys.has(metric.key),
    );
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
