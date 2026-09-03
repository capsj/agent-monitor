import { describe, expect, it } from "vitest";
import {
  claudeWorkspaceTrustTarget,
  isClaudeWorkspaceTrustPrompt,
  parseClaudeResetAt,
  parseClaudeUsage,
} from "../src/adapters/claude.js";
import { parseCursorAbout } from "../src/adapters/cursor.js";
import {
  parseClaudeDashboard,
  parseCursorDashboard,
  parseOpenCodeDashboard,
} from "../src/adapters/dashboard-parsers.js";
import { parseGeminiQuota } from "../src/adapters/gemini.js";
import { parseOpenCodeStats } from "../src/adapters/opencode.js";
import { dashboardContentReady } from "../src/dashboard-auth.js";

describe("provider parsers", () => {
  it("recognizes dashboard content before auto-closing the login window", () => {
    expect(dashboardContentReady("cursor", "Current plan Pro\nCursor Models\n24% used")).toBe(true);
    expect(dashboardContentReady("claude", "Plan usage limits\nCurrent session\n10% used")).toBe(true);
    expect(dashboardContentReady("opencode", "Rolling Usage\n0%\nWeekly Usage\n3%")).toBe(true);
    expect(dashboardContentReady("cursor", "Sign in to continue")).toBe(false);
  });

  it("parses Claude session and weekly windows", () => {
    const snapshot = parseClaudeUsage(`
      Claude Pro
      Current session 29% used · resets in 3h 12m
      Weekly limit 50% used · resets at Monday 10:00
    `);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.plan).toBe("Pro");
    expect(snapshot.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session",
          usedPercent: 29,
          resetDescription: "3h 12m",
        }),
        expect.objectContaining({
          id: "weekly",
          usedPercent: 50,
          resetDescription: "Monday 10:00",
        }),
      ]),
    );
  });

  it("does not invent Claude usage for an auth screen", () => {
    const snapshot = parseClaudeUsage("Authentication required. Log in to continue.");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("recognizes Claude workspace trust without inventing a Team plan", () => {
    const prompt = `
      Permission Required: Accessing workspace:
      /tmp/agent-monitor/claude-workspace
      Quick safety check: Is this a project you created or one you trust?
      Like your own code, a well-known open source project, or work from your team.
      Please answer y or n.
    `;
    const snapshot = parseClaudeUsage(prompt);

    expect(isClaudeWorkspaceTrustPrompt(prompt)).toBe(true);
    expect(claudeWorkspaceTrustTarget(prompt)).toBe(
      "/tmp/agent-monitor/claude-workspace",
    );
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.plan).toBeNull();
    expect(snapshot.message).toBe("Claude is waiting for workspace trust");
  });

  it("parses Claude's live usage screen and keeps reset times across redraws", () => {
    const now = new Date("2026-07-24T09:20:00.000Z");
    const snapshot = parseClaudeUsage(`
      Claude Pro
      Current session
      29% 28% used
      Resets 12:20pm (Europe/Andorra)
      Current week (all models)
      27% 27% used
      Resets Jul 29 at 2am (Europe/Andorra)
      +50% weekly limits promo through Aug 19
      24% of your usage came from subagent-heavy sessions
      Esc to cancel30% 30% used
    `, undefined, now);

    expect(snapshot.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session",
          usedPercent: 28,
          resetDescription: "12:20pm (Europe/Andorra)",
          resetsAt: "2026-07-24T10:20:00.000Z",
        }),
        expect.objectContaining({
          id: "weekly",
          usedPercent: 27,
          resetDescription: "Jul 29 at 2am (Europe/Andorra)",
          resetsAt: "2026-07-29T00:00:00.000Z",
        }),
      ]),
    );
  });

  it("converts Claude relative reset descriptions to timestamps", () => {
    expect(
      parseClaudeResetAt("3h 12m", new Date("2026-07-24T09:20:00.000Z")),
    ).toBe("2026-07-24T12:32:00.000Z");
  });

  it("keeps Claude included limits separate from usage credits", () => {
    const snapshot = parseClaudeUsage(`
      Claude Pro
      Current session 35% used · resets in 1h
      Usage credits are on
      $80.93 spent
      $80.00 monthly spend limit
      $19.07 Current balance
    `);

    expect(snapshot.windows[0]).toEqual(
      expect.objectContaining({ usedPercent: 35, category: "included" }),
    );
    expect(snapshot.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "additional_spent",
          value: 80.93,
          category: "additional",
        }),
        expect.objectContaining({
          key: "additional_limit",
          value: 80,
          category: "additional",
        }),
        expect.objectContaining({
          key: "credit_balance",
          value: 19.07,
          category: "additional",
        }),
        expect.objectContaining({
          key: "usage_credits_status",
          value: "on",
          category: "additional",
        }),
      ]),
    );
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

  it("marks Cursor personal usage as partial", () => {
    const snapshot = parseCursorAbout(`
      ✓ Login successful!
      Logged in
      Subscription Tier   Pro
    `);
    expect(snapshot.status).toBe("partial");
    expect(snapshot.plan).toBe("Pro");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("parses OpenCode Go included limits and balance from its dashboard", () => {
    const snapshot = parseOpenCodeDashboard(
      `
        Rolling Usage
        100%
        Resets in 1 hour 3 minutes
        Weekly Usage
        72%
        Resets in 2 days 14 hours
        Monthly Usage
        96%
        Resets in 2 days 8 hours
        $7.53
        Current Balance
      `,
      new Date("2026-07-24T10:00:00.000Z"),
    );

    expect(snapshot?.plan).toBe("Go");
    expect(snapshot?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rolling",
          usedPercent: 100,
          resetsAt: "2026-07-24T11:03:00.000Z",
        }),
        expect.objectContaining({ id: "weekly", usedPercent: 72 }),
        expect.objectContaining({ id: "monthly", usedPercent: 96 }),
      ]),
    );
    expect(snapshot?.metrics).toContainEqual(
      expect.objectContaining({ key: "credit_balance", value: 7.53 }),
    );
  });

  it("parses Claude usage credits separately from included limits", () => {
    const snapshot = parseClaudeDashboard(
      `
        Usage credits
        $80.93 spent
        101% used
        Resets Aug 1
        $80.00
        Monthly spend limit
        $19.07
        Current balance
      `,
      new Date("2026-07-24T10:00:00.000Z"),
    );

    expect(snapshot?.windows[0]).toEqual(
      expect.objectContaining({
        id: "usage_credits",
        usedPercent: 101,
        category: "additional",
      }),
    );
    expect(snapshot?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "additional_spent", value: 80.93 }),
        expect.objectContaining({ key: "additional_limit", value: 80 }),
        expect.objectContaining({ key: "credit_balance", value: 19.07 }),
      ]),
    );
  });

  it("parses Claude's current hash-route usage page credit details", () => {
    const snapshot = parseClaudeDashboard(
      `
        Plan usage limits Pro
        Current session
        Resets in 1 hr 28 min
        0% used
        Weekly limits
        All models
        Resets Wed 1:59 AM
        33% used
        Usage credits
        Turn on usage credits to keep using Claude if you hit a plan limit.
        $80.93 spent
        Resets Aug 1
        101% used
        $80.00
        Monthly spend limit
        $19.07
        Current balance · Auto-reload Off
        $19.06
        Promotional credit
        Expires September 19, 2026
      `,
      new Date("2026-07-25T10:00:00.000Z"),
    );

    expect(snapshot?.windows[0]).toEqual(
      expect.objectContaining({
        id: "usage_credits",
        usedPercent: 101,
        category: "additional",
      }),
    );
    expect(snapshot?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "additional_spent", value: 80.93 }),
        expect.objectContaining({ key: "additional_limit", value: 80 }),
        expect.objectContaining({ key: "credit_balance", value: 19.07 }),
        expect.objectContaining({
          key: "promotional_credit_balance",
          value: 19.06,
        }),
        expect.objectContaining({
          key: "promotional_credit_expiry",
          value: "September 19, 2026",
        }),
        expect.objectContaining({ key: "auto_reload_status", value: "off" }),
      ]),
    );
  });

  it("fails closed while parsing Cursor dashboard fields", () => {
    const snapshot = parseCursorDashboard(
      `
        Cursor Pro
        Included Usage
        $12.50 / $20.00
        62.5% used
        Renews on Aug 1
        On-demand usage
        $3.20
      `,
      new Date("2026-07-24T10:00:00.000Z"),
    );

    expect(snapshot?.plan).toBe("Pro");
    expect(snapshot?.windows[0]).toEqual(
      expect.objectContaining({ id: "included", usedPercent: 62.5 }),
    );
    expect(snapshot?.metrics[0]).toEqual(
      expect.objectContaining({ key: "additional_spent", value: 3.2 }),
    );
  });

  it("parses Cursor's current spending dashboard model limits", () => {
    const snapshot = parseCursorDashboard(
      `
        CURRENT PLAN
        Pro $20/mo
        Usage limits reset on 8 Aug (15 days left)
        Included in Pro
        Cursor Models · Includes Cursor Grok 4.5 and Composer 2.5
        24% used
        Other Models
        71% used
        On-Demand Usage
        On-Demand Spending
        Disabled
        On-demand spending is currently disabled
        Monthly Limit
        Disabled
      `,
      new Date("2026-07-25T08:00:00.000Z"),
    );

    expect(snapshot?.plan).toBe("Pro");
    expect(snapshot?.windows).toEqual([
      expect.objectContaining({
        id: "monthly_cursor_models",
        usedPercent: 24,
        resetsAt: "2026-08-07T22:00:00.000Z",
      }),
      expect.objectContaining({
        id: "monthly_other_models",
        usedPercent: 71,
        resetsAt: "2026-08-07T22:00:00.000Z",
      }),
    ]);
    expect(snapshot?.metrics).toContainEqual(
      expect.objectContaining({
        key: "on_demand_status",
        value: "disabled",
      }),
    );
  });
});
