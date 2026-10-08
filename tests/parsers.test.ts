import { describe, expect, it } from "vitest";
import {
  claudePlanLabel,
  claudeWorkspaceTrustTarget,
  isClaudeWorkspaceTrustPrompt,
  parseClaudeUsageResponse,
} from "../src/adapters/claude.js";
import { cursorUserId, parseCursorUsage } from "../src/adapters/cursor.js";
import { parseGeminiQuota } from "../src/adapters/gemini.js";
import { parseOpenCodeStats } from "../src/adapters/opencode.js";

describe("provider parsers", () => {
  it("recognizes Claude's workspace trust prompt", () => {
    const prompt = `
      Permission Required: Accessing workspace:
      /tmp/agent-monitor/claude-workspace
      Quick safety check: Is this a project you created or one you trust?
      Like your own code, a well-known open source project, or work from your team.
      Please answer y or n.
    `;

    expect(isClaudeWorkspaceTrustPrompt(prompt)).toBe(true);
    expect(claudeWorkspaceTrustTarget(prompt)).toBe(
      "/tmp/agent-monitor/claude-workspace",
    );
  });

  it("parses Claude's OAuth usage limits and extra usage", () => {
    const usage = parseClaudeUsageResponse({
      five_hour: { utilization: 9, resets_at: "2026-10-08T13:00:00.215956+00:00" },
      seven_day: { utilization: 2, resets_at: "2026-10-10T01:00:00.215976+00:00" },
      limits: [
        { kind: "session", group: "session", percent: 9, resets_at: "2026-10-08T13:00:00.215956+00:00", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 2, resets_at: "2026-10-10T01:00:00.215976+00:00", scope: null },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 3,
          resets_at: "2026-10-10T01:00:00.216185+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
        },
        { kind: "mystery_future_limit", percent: 50, resets_at: null },
      ],
      extra_usage: {
        is_enabled: false,
        monthly_limit: 1300,
        used_credits: 0,
        currency: "USD",
        decimal_places: 2,
        disabled_reason: "out_of_credits",
      },
      iguana_necktie: { utilization: 17.5, limit_dollars: 250 },
    });

    expect(usage?.windows).toEqual([
      expect.objectContaining({
        id: "session",
        label: "Session",
        usedPercent: 9,
        resetsAt: "2026-10-08T13:00:00.215Z",
        category: "included",
      }),
      expect.objectContaining({ id: "weekly", label: "Weekly", usedPercent: 2 }),
      expect.objectContaining({ id: "weekly_fable", label: "Weekly Fable", usedPercent: 3 }),
    ]);
    expect(usage?.metrics).toEqual([
      expect.objectContaining({ key: "additional_spent", value: 0, category: "additional" }),
      expect.objectContaining({ key: "additional_limit", value: 13 }),
      expect.objectContaining({ key: "usage_credits_status", value: "off" }),
    ]);
  });

  it("falls back to Claude's named windows when no limits list is present", () => {
    const usage = parseClaudeUsageResponse({
      five_hour: { utilization: 34, resets_at: "2026-10-01T17:20:00Z" },
      seven_day: { utilization: 30, resets_at: "2026-10-07T00:00:00Z" },
      seven_day_sonnet: { utilization: 12, resets_at: "2026-10-07T00:00:00Z" },
      seven_day_opus: null,
      extra_usage: null,
    });

    expect(usage?.windows.map((window) => window.id)).toEqual([
      "session",
      "weekly",
      "weekly_sonnet",
    ]);
    expect(usage?.metrics).toEqual([]);
  });

  it("fails closed on an unrecognized Claude usage payload", () => {
    expect(parseClaudeUsageResponse({ five_hour: "lots" })).toBeUndefined();
    expect(parseClaudeUsageResponse("<html>")).toBeUndefined();
  });

  it("labels Claude plans from the profile organization", () => {
    expect(
      claudePlanLabel({
        organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
      }),
    ).toBe("Max 5x");
    expect(
      claudePlanLabel({
        organization: { organization_type: "claude_team", rate_limit_tier: "default_raven" },
      }),
    ).toBe("Team");
    expect(claudePlanLabel({ organization: { organization_type: "claude_mystery" } })).toBeNull();
    expect(claudePlanLabel({ account: { email: "x" } })).toBeNull();
  });

  it("parses Cursor's dashboard usage summary in dollars", () => {
    const usage = parseCursorUsage(
      {
        billingCycleStart: "2026-09-08T12:11:07.000Z",
        billingCycleEnd: "2026-10-08T12:11:07.000Z",
        membershipType: "pro",
        limitType: "user",
        individualUsage: {
          plan: {
            enabled: true,
            used: 2000,
            limit: 2000,
            remaining: 0,
            breakdown: { included: 2000, bonus: 25801, total: 27801 },
            autoPercentUsed: 54.15,
            apiPercentUsed: 100,
            totalPercentUsed: 57.47,
          },
          onDemand: { enabled: false, used: 4856, limit: null, remaining: null },
        },
        teamUsage: {},
      },
      { membershipType: "pro", individualMembershipType: "pro", isYearlyPlan: false },
    );

    expect(usage?.plan).toBe("Pro");
    expect(usage?.windows).toEqual([
      expect.objectContaining({
        id: "monthly_auto_models",
        label: "Auto models",
        usedPercent: 54.15,
        resetsAt: "2026-10-08T12:11:07.000Z",
        category: "included",
      }),
      expect.objectContaining({ id: "monthly_other_models", usedPercent: 100 }),
    ]);
    expect(usage?.metrics).toEqual([
      expect.objectContaining({ key: "included_spent", value: 20 }),
      expect.objectContaining({ key: "included_limit", value: 20 }),
      expect.objectContaining({ key: "bonus_usage", value: 258.01 }),
      expect.objectContaining({ key: "on_demand_status", value: "disabled" }),
    ]);
  });

  it("exposes Cursor on-demand spending as additional usage when enabled", () => {
    const usage = parseCursorUsage({
      billingCycleEnd: "1791461467000",
      individualUsage: {
        plan: { enabled: true, autoPercentUsed: 10, apiPercentUsed: 20 },
        onDemand: { enabled: true, used: 1250, limit: 5000 },
      },
    });

    expect(usage?.windows).toContainEqual(
      expect.objectContaining({
        id: "on_demand",
        usedPercent: 25,
        category: "additional",
        resetsAt: "2026-10-08T12:11:07.000Z",
      }),
    );
    expect(usage?.metrics).toContainEqual(
      expect.objectContaining({ key: "on_demand_spent", value: 12.5 }),
    );
    expect(parseCursorUsage("<html>")).toBeUndefined();
  });

  it("extracts the Cursor user id from its session token", () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: "github|user_01ABC", type: "session" }),
    ).toString("base64url");
    expect(cursorUserId(`header.${payload}.signature`)).toBe("user_01ABC");
    expect(cursorUserId("not-a-token")).toBeUndefined();
  });

  it("parses Gemini model quota rows when the CLI exposes them", () => {
    const snapshot = parseGeminiQuota(`
      Model usage
      Pro          ▬▬▬▬▬▬▬       42% Resets: 2h 14m
      Flash        ▬▬▬            8% Resets: 47m
    `);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pro", usedPercent: 42 }),
        expect.objectContaining({ label: "Flash", usedPercent: 8 }),
      ]),
    );
  });

  it("explains when Gemini cannot return quota without an API call", () => {
    const snapshot = parseGeminiQuota("No API calls have been made in this session.");

    expect(snapshot.status).toBe("partial");
    expect(snapshot.summary).toBe("Quota not available yet");
    expect(snapshot.message).toContain("authentication method");
  });

  it("parses OpenCode local stats", () => {
    const snapshot = parseOpenCodeStats(`
      │ Sessions                                              3 │
      │ Messages                                            239 │
      │ Total Cost                                       $15.30 │
      │ Input                                            754.0K │
      │ Output                                            53.9K │
      │ Cache Read                                        35.7M │
      │ Cache Write                                           0 │
    `, undefined, "OpenCode Go api");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.plan).toBe("Go");
    expect(snapshot.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "sessions", value: 3 }),
        expect.objectContaining({
          key: "estimated_cost",
          value: 15.3,
          category: "local",
        }),
        expect.objectContaining({ key: "input_tokens", value: 754_000 }),
      ]),
    );
  });
});
