import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { MonitorConfig } from "../src/config.js";
import type { MonitorEngine } from "../src/core/engine.js";
import type { MonitorState, ProviderSnapshot } from "../src/types.js";
import { App } from "../src/ui/App.js";

const config: MonitorConfig = {
  enabledProviders: ["codex", "cursor"],
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

function mockEngine(state: MonitorState): MonitorEngine {
  return {
    keys: () => [...state.snapshots.keys()],
    subscribe(listener: (value: MonitorState) => void) {
      listener(state);
      return () => undefined;
    },
    refreshAll: vi.fn(),
    togglePaused: vi.fn(),
  } as unknown as MonitorEngine;
}

describe("dashboard", () => {
  it("renders provider health and an honest partial state", async () => {
    const codex: ProviderSnapshot = {
      providerId: "codex",
      providerName: "Codex",
      collectedAt: "2026-07-24T08:00:00.000Z",
      status: "ok",
      source: "structured",
      plan: "plus",
      summary: "22% used",
      windows: [
        {
          id: "primary",
          label: "5-hour",
          usedPercent: 22,
          resetDescription: "5-hour window",
          quality: "exact",
        },
        {
          id: "secondary",
          label: "1-week",
          usedPercent: 41,
          resetDescription: "1-week window",
          quality: "exact",
        },
        {
          id: "monthly",
          label: "Monthly",
          usedPercent: 12,
          resetDescription: "Jul 31",
          quality: "exact",
        },
      ],
      metrics: [
        {
          key: "lifetime_tokens",
          label: "Lifetime tokens",
          value: 1_000,
          unit: "tokens",
          quality: "exact",
          category: "local",
        },
      ],
      message: null,
      version: "test",
    };
    const cursor: ProviderSnapshot = {
      providerId: "cursor",
      providerName: "Cursor",
      collectedAt: "2026-07-24T08:00:00.000Z",
      status: "partial",
      source: "cli",
      plan: "Pro",
      summary: "Account detected · usage unavailable",
      windows: [],
      metrics: [],
      message: "Personal usage is not exposed",
      version: "test",
    };
    const instance = render(
      <App
        engine={mockEngine({
          snapshots: new Map([
            ["codex", codex],
            ["cursor", cursor],
          ]),
          refreshing: new Set(),
          paused: false,
        })}
        config={config}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = instance.lastFrame();
    expect(frame).toContain("agent-monitor");
    expect(frame).toContain("LIVE");
    expect(frame).toContain("Codex");
    expect(frame).toContain("Plan");
    expect(frame).toContain("5-hour");
    expect(frame).toContain("78% left");
    expect(frame).toContain("1-week");
    expect(frame).toContain("59% left");
    expect(frame).toContain("Monthly");
    expect(frame).toContain("88% left");
    expect(frame).toContain("Cursor");
  });

  it("labels each configured account of a provider", async () => {
    const claude = (accountId: string, accountLabel: string, usedPercent: number): ProviderSnapshot => ({
      providerId: "claude",
      providerName: "Claude Code",
      accountId,
      accountLabel,
      collectedAt: "2026-07-24T08:00:00.000Z",
      status: "ok",
      source: "api",
      plan: accountId === "work" ? "Team" : "Max 5x",
      summary: `${100 - usedPercent}% left in session`,
      windows: [{ id: "session", label: "Session", usedPercent, quality: "exact", category: "included" }],
      metrics: [],
      message: null,
      version: "test",
    });
    const instance = render(
      <App
        engine={mockEngine({
          snapshots: new Map([
            ["claude:personal", claude("personal", "Personal", 9)],
            ["claude:work", claude("work", "Work", 42)],
          ]),
          refreshing: new Set(),
          paused: false,
        })}
        config={config}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = instance.lastFrame();
    expect(frame).toContain("Claude Code · Personal");
    expect(frame).toContain("Max 5x");
    expect(frame).toContain("91% left");
    expect(frame).toContain("Claude Code · Work");
    expect(frame).toContain("Team");
    expect(frame).toContain("58% left");
  });
});
