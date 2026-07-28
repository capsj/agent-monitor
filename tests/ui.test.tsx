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
    cursor: "cursor-agent",
    opencode: "opencode",
    gemini: "gemini",
  },
  warningPercent: 70,
  criticalPercent: 90,
  retentionDays: 90,
  historyEnabled: false,
  collectionTimeoutMs: 15_000,
};

function mockEngine(state: MonitorState): MonitorEngine {
  return {
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

  it("authenticates the selected dashboard from the keyboard", async () => {
    const authenticateProvider = vi
      .fn()
      .mockResolvedValue("https://cursor.com/dashboard/usage");
    const instance = render(
      <App
        engine={mockEngine({
          snapshots: new Map(),
          refreshing: new Set(),
          paused: false,
        })}
        config={{ ...config, enabledProviders: ["cursor"] }}
        authenticateProvider={authenticateProvider}
      />,
    );

    instance.stdin.write("a");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(authenticateProvider).toHaveBeenCalledWith(
      "cursor",
      "isolated",
      expect.anything(),
    );
    expect(instance.lastFrame()).toContain("Dashboard connected");
    expect(instance.lastFrame()).toContain("Cursor connected at cursor.com");
  });

  it("can authenticate through the personal Chrome session", async () => {
    const authenticateProvider = vi
      .fn()
      .mockResolvedValue("https://cursor.com/dashboard/usage");
    const instance = render(
      <App
        engine={mockEngine({
          snapshots: new Map(),
          refreshing: new Set(),
          paused: false,
        })}
        config={{ ...config, enabledProviders: ["cursor"] }}
        authenticateProvider={authenticateProvider}
      />,
    );

    instance.stdin.write("A");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(authenticateProvider).toHaveBeenCalledWith(
      "cursor",
      "personal",
      expect.anything(),
    );
    expect(instance.lastFrame()).toContain("using personal Chrome");
  });

  it("cancels an authentication that is still waiting on Chrome", async () => {
    const authenticateProvider = vi.fn(
      (
        _provider: string,
        _mode: string,
        signal?: AbortSignal,
      ) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("Dashboard authentication cancelled"));
          });
        }),
    );
    const instance = render(
      <App
        engine={mockEngine({
          snapshots: new Map(),
          refreshing: new Set(),
          paused: false,
        })}
        config={{ ...config, enabledProviders: ["cursor"] }}
        authenticateProvider={authenticateProvider}
      />,
    );

    instance.stdin.write("A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("q");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(instance.lastFrame()).toContain("Dashboard authentication cancelled");
  });
});
