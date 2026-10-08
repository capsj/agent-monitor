import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeCredentialExpired,
  claudeKeychainService,
  parseClaudeCredential,
  readClaudeCredential,
} from "../src/adapters/claude-credentials.js";
import { ClaudeAdapter, fetchClaudeUsage } from "../src/adapters/claude.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const usagePayload = {
  five_hour: { utilization: 9, resets_at: "2026-10-08T13:00:00Z" },
  seven_day: { utilization: 2, resets_at: "2026-10-10T01:00:00Z" },
  extra_usage: null,
};

describe("Claude Code credentials", () => {
  it("derives the keychain item name from the configuration directory", () => {
    expect(claudeKeychainService("/home/dev/.claude-work")).toBe(
      "Claude Code-credentials-685abfe8",
    );
    expect(claudeKeychainService("/home/dev/.claude-work/")).toBe(
      "Claude Code-credentials-685abfe8",
    );
  });

  it("reads only the access token and expiry from a credential record", () => {
    const credential = parseClaudeCredential(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: 1_791_451_816_362,
          scopes: ["user:inference"],
        },
      }),
    );

    expect(credential).toEqual({ accessToken: "access-secret", expiresAt: 1_791_451_816_362 });
    expect(JSON.stringify(credential)).not.toContain("refresh-secret");
    expect(parseClaudeCredential("{}")).toBeUndefined();
    expect(parseClaudeCredential("not json")).toBeUndefined();
  });

  it("treats tokens as expired shortly before their deadline", () => {
    const now = Date.parse("2026-10-08T09:00:00Z");
    expect(claudeCredentialExpired({ accessToken: "x", expiresAt: now + 10_000 }, now)).toBe(true);
    expect(claudeCredentialExpired({ accessToken: "x", expiresAt: now + 120_000 }, now)).toBe(false);
    expect(claudeCredentialExpired({ accessToken: "x" }, now)).toBe(false);
  });

  it("falls back to the credentials file outside the macOS keychain", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-monitor-claude-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-secret", expiresAt: 1 } }),
    );

    expect(await readClaudeCredential(directory, "linux")).toEqual({
      accessToken: "file-secret",
      expiresAt: 1,
    });
    expect(await readClaudeCredential(join(directory, "missing"), "linux")).toBeUndefined();
  });
});

describe("Claude usage API", () => {
  it("sends the token only as an OAuth bearer header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(usagePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchClaudeUsage("access-secret", 1_000, fetcher);

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-secret",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      }),
    );
  });

  it("reports expired sign-ins and redacts other failures", async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", { status: 401 }));
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: "server-secret" }), { status: 200 }),
    );

    expect(await fetchClaudeUsage("access-secret", 1_000, rejected)).toEqual({ status: "unauthorized" });
    const malformedResult = await fetchClaudeUsage("access-secret", 1_000, malformed);
    expect(malformedResult).toEqual(expect.objectContaining({ status: "error" }));
    expect(JSON.stringify(malformedResult)).not.toMatch(/access-secret|server-secret/);
  });

  it("collects per-account snapshots without launching the CLI", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/usage")) return Response.json(usagePayload);
      return Response.json({
        organization: { organization_type: "claude_team", rate_limit_tier: "default_raven" },
      });
    });
    const adapter = new ClaudeAdapter({
      executable: "/nonexistent/claude",
      account: { id: "work", label: "Work", configDir: "/tmp/agent-monitor-work" },
      multiAccount: true,
      fetcher,
      credentialReader: async () => ({ accessToken: "access-secret", expiresAt: Date.now() + 3_600_000 }),
    });

    const snapshot = await adapter.collect();

    expect(adapter.accountId).toBe("work");
    expect(snapshot).toMatchObject({
      providerId: "claude",
      accountId: "work",
      accountLabel: "Work",
      status: "ok",
      source: "api",
      plan: "Team",
      summary: "91% left in session",
    });
    expect(snapshot.windows).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("access-secret");
  });

  it("reports a missing sign-in instead of guessing", async () => {
    const adapter = new ClaudeAdapter({
      executable: "/nonexistent/claude",
      fetcher: vi.fn<typeof fetch>(),
      credentialReader: async () => undefined,
    });

    const snapshot = await adapter.collect();

    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.accountId).toBeUndefined();
    expect(snapshot.message).toContain("sign in");
  });
});
