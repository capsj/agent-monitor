import { describe, expect, it, vi } from "vitest";
import type { MonitorConfig } from "../src/config.js";
import { MonitorEngine } from "../src/core/engine.js";
import type { ProviderAdapter, ProviderSnapshot } from "../src/types.js";

const config: MonitorConfig = {
  enabledProviders: ["codex"],
  refreshSeconds: { codex: 30, claude: 60, cursor: 300, opencode: 30, gemini: 60 },
  executables: {
    codex: "codex",
    claude: "claude",
    opencode: "opencode",
    gemini: "gemini",
  },
  accounts: { claude: [{ id: "default" }] },
  warningPercent: 70,
  criticalPercent: 90,
  retentionDays: 90,
  historyEnabled: false,
  reuseProviderCredentials: true,
  collectionTimeoutMs: 15_000,
};

const goodSnapshot: ProviderSnapshot = {
  providerId: "codex",
  providerName: "Codex",
  collectedAt: "2026-07-24T08:00:00.000Z",
  status: "ok",
  source: "structured",
  plan: "plus",
  summary: "10% used",
  windows: [
    { id: "primary", label: "Primary", usedPercent: 10, quality: "exact" },
  ],
  metrics: [],
  message: null,
};

describe("monitor engine", () => {
  it("keeps the last good values as stale when refresh fails", async () => {
    const collect = vi
      .fn<() => Promise<ProviderSnapshot>>()
      .mockResolvedValueOnce(goodSnapshot)
      .mockRejectedValueOnce(new Error("offline"));
    const adapter: ProviderAdapter = {
      id: "codex",
      name: "Codex",
      defaultRefreshMs: 30_000,
      detect: async () => ({ available: true }),
      collect,
    };
    const engine = new MonitorEngine([adapter], config);
    await engine.start();
    expect(engine.getState().snapshots.get("codex")?.status).toBe("ok");
    await engine.collect("codex", true);
    const stale = engine.getState().snapshots.get("codex");
    expect(stale?.status).toBe("stale");
    expect(stale?.summary).toBe("10% used");
    expect(stale?.message).toContain("offline");
    await engine.stop();
  });

  it("keeps the last good values when a refresh returns an empty partial snapshot", async () => {
    const partialSnapshot: ProviderSnapshot = {
      ...goodSnapshot,
      collectedAt: "2026-07-24T08:01:00.000Z",
      status: "partial",
      summary: "Usage unavailable",
      windows: [],
      metrics: [],
      message: "Rate limits were temporarily unavailable",
    };
    const collect = vi
      .fn<() => Promise<ProviderSnapshot>>()
      .mockResolvedValueOnce(goodSnapshot)
      .mockResolvedValueOnce(partialSnapshot);
    const adapter: ProviderAdapter = {
      id: "codex",
      name: "Codex",
      defaultRefreshMs: 30_000,
      detect: async () => ({ available: true }),
      collect,
    };
    const engine = new MonitorEngine([adapter], config);
    await engine.start();
    await engine.collect("codex", true);

    const stale = engine.getState().snapshots.get("codex");
    expect(stale?.status).toBe("stale");
    expect(stale?.summary).toBe("10% used");
    expect(stale?.windows).toEqual([
      expect.objectContaining({ id: "primary", usedPercent: 10, quality: "stale" }),
    ]);
    expect(stale?.collectedAt).toBe(goodSnapshot.collectedAt);
    expect(stale?.message).toContain("temporarily unavailable");
    await engine.stop();
  });

  it("preserves individual dashboard metrics missing from a partial CLI refresh", async () => {
    const complete: ProviderSnapshot = {
      ...goodSnapshot,
      metrics: [
        {
          key: "credit_balance",
          label: "Current balance",
          value: 19.07,
          unit: "currency",
          quality: "exact",
          category: "additional",
        },
      ],
    };
    const partial: ProviderSnapshot = {
      ...goodSnapshot,
      collectedAt: "2026-07-24T08:01:00.000Z",
      status: "partial",
      metrics: [],
      message: "Dashboard refresh failed",
    };
    const collect = vi
      .fn<() => Promise<ProviderSnapshot>>()
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce(partial);
    const adapter: ProviderAdapter = {
      id: "codex",
      name: "Codex",
      defaultRefreshMs: 30_000,
      detect: async () => ({ available: true }),
      collect,
    };
    const engine = new MonitorEngine([adapter], config);
    await engine.start();
    await engine.collect("codex", true);

    const stale = engine.getState().snapshots.get("codex");
    expect(stale?.status).toBe("stale");
    expect(stale?.metrics).toContainEqual(
      expect.objectContaining({ key: "credit_balance", value: 19.07 }),
    );
    await engine.stop();
  });

  it("keeps snapshots for several accounts of one provider apart", async () => {
    const account = (id: string, usedPercent: number): ProviderAdapter => ({
      id: "claude",
      name: "Claude Code",
      accountId: id,
      accountLabel: id === "work" ? "Work" : "Personal",
      defaultRefreshMs: 60_000,
      detect: async () => ({ available: true }),
      collect: async () => ({
        ...goodSnapshot,
        providerId: "claude",
        providerName: "Claude Code",
        accountId: id,
        windows: [{ id: "session", label: "Session", usedPercent, quality: "exact" }],
      }),
    });
    const engine = new MonitorEngine([account("personal", 10), account("work", 42)], config);
    await engine.start();

    expect(engine.keys()).toEqual(["claude:personal", "claude:work"]);
    expect(engine.getState().snapshots.get("claude:personal")?.windows[0]?.usedPercent).toBe(10);
    expect(engine.getState().snapshots.get("claude:work")?.windows[0]?.usedPercent).toBe(42);
    await engine.stop();
  });
});
