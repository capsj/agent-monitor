import { describe, expect, it } from "vitest";
import { monitorStateMessage, parseStreamCommand } from "../src/stream.js";
import type { MonitorState, ProviderSnapshot } from "../src/types.js";

const snapshot: ProviderSnapshot = {
  providerId: "codex",
  providerName: "Codex",
  collectedAt: "2026-07-28T14:30:00.000Z",
  status: "ok",
  source: "structured",
  plan: "Plus",
  summary: "80% left",
  windows: [
    {
      id: "primary",
      label: "5-hour",
      usedPercent: 20,
      quality: "exact",
      category: "included",
    },
  ],
  metrics: [],
};

describe("monitor state stream", () => {
  it("serializes maps and sets into a JSON-friendly state message", () => {
    const state: MonitorState = {
      snapshots: new Map([["codex", snapshot]]),
      refreshing: new Set(["codex"]),
      paused: false,
    };

    const message = monitorStateMessage(state);

    expect(message.type).toBe("state");
    expect(message.paused).toBe(false);
    expect(message.refreshing).toEqual(["codex"]);
    expect(message.snapshots).toEqual([snapshot]);
    expect(Number.isNaN(Date.parse(message.emittedAt))).toBe(false);
    expect(JSON.parse(JSON.stringify(message))).toMatchObject({
      type: "state",
      snapshots: [{ providerId: "codex" }],
    });
  });

  it("accepts provider refresh and managed dashboard authentication commands", () => {
    expect(parseStreamCommand('{"action":"refresh","providerId":"cursor"}')).toEqual({
      action: "refresh",
      providerId: "cursor",
    });
    expect(
      parseStreamCommand(
        '{"action":"authenticateDashboard","providerId":"cursor","mode":"isolated"}',
      ),
    ).toEqual({
      action: "authenticateDashboard",
      providerId: "cursor",
      mode: "isolated",
    });
    expect(parseStreamCommand('{"action":"cancelAuthentication"}')).toEqual({
      action: "cancelAuthentication",
    });
  });

  it("ignores unsupported authentication providers", () => {
    expect(
      parseStreamCommand(
        '{"action":"authenticateDashboard","providerId":"gemini","mode":"isolated"}',
      ),
    ).toBeUndefined();
    expect(parseStreamCommand('{"action":"refresh","providerId":"unknown"}')).toBeUndefined();
  });
});
