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

  it("accepts refresh commands for one snapshot key or every provider", () => {
    expect(parseStreamCommand('{"action":"refresh","key":"claude:work"}')).toEqual({
      action: "refresh",
      key: "claude:work",
    });
    expect(parseStreamCommand('{"action":"refresh"}')).toEqual({ action: "refresh" });
    expect(parseStreamCommand('{"action":"togglePause"}')).toEqual({ action: "togglePause" });
  });

  it("ignores malformed or unknown commands", () => {
    expect(parseStreamCommand('{"action":"refresh","key":42}')).toBeUndefined();
    expect(parseStreamCommand('{"action":"authenticateDashboard"}')).toBeUndefined();
    expect(parseStreamCommand("not json")).toBeUndefined();
  });
});
