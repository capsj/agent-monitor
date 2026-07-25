import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStore } from "../src/core/history.js";
import { computeTrend, sparkline } from "../src/core/trends.js";
import type { ProviderSnapshot } from "../src/types.js";

const temporaryDirectories: string[] = [];

function snapshot(at: string, usedPercent: number): ProviderSnapshot {
  return {
    providerId: "codex",
    providerName: "Codex",
    collectedAt: at,
    status: "ok",
    source: "structured",
    plan: "plus",
    summary: `${usedPercent}% used`,
    windows: [
      {
        id: "primary",
        label: "Primary",
        usedPercent,
        resetsAt: "2026-07-30T00:00:00.000Z",
        quality: "exact",
      },
    ],
    metrics: [],
    message: null,
    version: "test",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("history", () => {
  it("stores changes but suppresses identical snapshots before heartbeat", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-monitor-test-"));
    temporaryDirectories.push(directory);
    const store = new HistoryStore(join(directory, "history.sqlite3"));
    const first = snapshot("2026-07-24T08:00:00.000Z", 10);
    const same = snapshot("2026-07-24T08:01:00.000Z", 10);
    const changed = snapshot("2026-07-24T08:02:00.000Z", 12);
    expect(store.record(first)).toBe(true);
    expect(store.record(same)).toBe(false);
    expect(store.record(changed)).toBe(true);
    expect(store.recent("codex", new Date("2026-07-24T00:00:00.000Z"))).toHaveLength(2);
    store.close();
  });

  it("computes deltas and a sparkline from native metrics", () => {
    const history = [
      snapshot("2026-07-23T08:00:00.000Z", 10),
      snapshot("2026-07-24T07:00:00.000Z", 20),
      snapshot("2026-07-24T08:00:00.000Z", 25),
    ];
    const trend = computeTrend(history);
    expect(trend.delta1h).toBe(5);
    expect(trend.delta24h).toBe(15);
    expect(trend.sparkline).toHaveLength(3);
    expect(trend.estimatedTimeToLimitSec).toBeGreaterThan(0);
  });

  it("renders constant sparklines safely", () => {
    expect(sparkline([4, 4, 4])).toBe("▁▁▁");
  });
});
