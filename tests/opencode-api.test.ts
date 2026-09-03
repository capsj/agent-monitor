import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenCodeGoUsage,
  parseOpenCodeGoUsage,
  readOpenCodeGoKey,
} from "../src/adapters/opencode.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const usagePayload = {
  usage: {
    rolling: { status: "ok", percent: 9, resetsAt: "2026-09-03T12:00:00.000Z" },
    weekly: { status: "ok", percent: 24, resetsAt: "2026-09-07T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 99, resetsAt: "2026-10-01T00:00:00.000Z" },
  },
};

describe("OpenCode Go API", () => {
  it("reads only the OpenCode Go API credential shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-monitor-opencode-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    writeFileSync(path, JSON.stringify({
      anthropic: { type: "oauth", access: "do-not-use", refresh: "also-do-not-use" },
      "opencode-go": { type: "api", key: "go-secret" },
    }));

    expect(readOpenCodeGoKey(path)).toBe("go-secret");
  });

  it("parses whole percentages and treats rate-limited windows as exhausted", () => {
    const usage = parseOpenCodeGoUsage(usagePayload);

    expect(usage?.windows).toEqual([
      expect.objectContaining({ id: "rolling", usedPercent: 9 }),
      expect.objectContaining({ id: "weekly", usedPercent: 24 }),
      expect.objectContaining({ id: "monthly", usedPercent: 100 }),
    ]);
  });

  it("sends the key only in the provider authorization header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(usagePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchOpenCodeGoUsage("go-secret", 1_000, fetcher);

    expect(result.status).toBe("ok");
    expect(fetcher).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer go-secret" }),
      }),
    );
  });

  it("returns redacted errors for rejected and malformed responses", async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", { status: 401 }));
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: "server-secret" }), { status: 200 }),
    );

    const rejectedResult = await fetchOpenCodeGoUsage("go-secret", 1_000, rejected);
    const malformedResult = await fetchOpenCodeGoUsage("go-secret", 1_000, malformed);

    expect(rejectedResult).toEqual(expect.objectContaining({ status: "error" }));
    expect(malformedResult).toEqual(expect.objectContaining({ status: "error" }));
    expect(JSON.stringify([rejectedResult, malformedResult])).not.toMatch(/go-secret|server-secret/);
  });
});
