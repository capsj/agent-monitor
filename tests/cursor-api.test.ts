import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CursorAdapter,
  fetchCursorUsage,
  readCursorSessionToken,
} from "../src/adapters/cursor.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function sessionToken(sub = "github|user_01ABC"): string {
  const payload = Buffer.from(JSON.stringify({ sub, type: "session" })).toString("base64url");
  return `header.${payload}.signature`;
}

function stateDatabase(token?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-monitor-cursor-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.vscdb");
  const db = new Database(path);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/refreshToken", "refresh-secret");
  if (token) db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/accessToken", token);
  db.close();
  return path;
}

const summaryPayload = {
  billingCycleEnd: "2026-10-08T12:11:07.000Z",
  membershipType: "pro",
  individualUsage: {
    plan: { enabled: true, used: 2000, limit: 2000, autoPercentUsed: 54, apiPercentUsed: 100 },
    onDemand: { enabled: false, used: 0, limit: null },
  },
};

describe("Cursor dashboard API", () => {
  it("reads only the session token from Cursor's state database", () => {
    expect(readCursorSessionToken(stateDatabase(sessionToken()))).toBe(sessionToken());
    expect(readCursorSessionToken(stateDatabase())).toBeUndefined();
    expect(readCursorSessionToken("/nonexistent/state.vscdb")).toBeUndefined();
  });

  it("sends the token as the dashboard session cookie", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      Response.json(String(input).includes("usage-summary") ? summaryPayload : { membershipType: "pro" }),
    );

    const result = await fetchCursorUsage(sessionToken(), 1_000, fetcher);

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "https://cursor.com/api/usage-summary",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`user_01ABC::${sessionToken()}`)}`,
        }),
      }),
    );
  });

  it("reports expired sessions and unrecognized payloads without leaking the token", async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "not_authenticated" }, { status: 401 }),
    );
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "server-secret" }));

    expect(await fetchCursorUsage(sessionToken(), 1_000, rejected)).toEqual({ status: "unauthorized" });
    const malformedResult = await fetchCursorUsage(sessionToken(), 1_000, malformed);
    expect(malformedResult).toEqual(expect.objectContaining({ status: "error" }));
    expect(JSON.stringify(malformedResult)).not.toMatch(/signature|server-secret/);
  });

  it("collects usage from the local token and dashboard API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      Response.json(
        String(input).includes("usage-summary")
          ? summaryPayload
          : { individualMembershipType: "pro", isYearlyPlan: true },
      ),
    );
    const adapter = new CursorAdapter(300_000, 1_000, true, stateDatabase(sessionToken()), fetcher);

    const snapshot = await adapter.collect();

    expect(snapshot).toMatchObject({
      providerId: "cursor",
      status: "ok",
      source: "api",
      plan: "Pro (yearly)",
      summary: "46% left",
    });
    expect(snapshot.windows.map((window) => window.id)).toEqual([
      "monthly_auto_models",
      "monthly_other_models",
    ]);
  });

  it("asks for a Cursor sign-in when no token is stored", async () => {
    const adapter = new CursorAdapter(300_000, 1_000, true, stateDatabase(), vi.fn<typeof fetch>());

    const snapshot = await adapter.collect();

    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toContain("Sign in");
  });
});
