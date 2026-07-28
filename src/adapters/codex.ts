import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ProviderAdapter, ProviderSnapshot, UsageWindow } from "../types.js";
import { nowIso } from "../types.js";
import { formatWindowUsage } from "../utils/format.js";
import { detectVersion } from "../utils/process.js";

const rateWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .nullable();

const rateSnapshotSchema = z.object({
  limitId: z.string().nullable(),
  limitName: z.string().nullable(),
  primary: rateWindowSchema,
  secondary: rateWindowSchema,
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
  individualLimit: z
    .object({
      limit: z.string(),
      used: z.string(),
      remainingPercent: z.number(),
      resetsAt: z.number(),
    })
    .nullable(),
  planType: z.string().nullable(),
  rateLimitReachedType: z.string().nullable(),
});

const rateResponseSchema = z.object({
  rateLimits: rateSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), rateSnapshotSchema).nullable(),
});

const usageResponseSchema = z.object({
  summary: z.object({
    lifetimeTokens: z.union([z.number(), z.string()]).nullable(),
    peakDailyTokens: z.union([z.number(), z.string()]).nullable(),
    longestRunningTurnSec: z.union([z.number(), z.string()]).nullable(),
    currentStreakDays: z.union([z.number(), z.string()]).nullable(),
    longestStreakDays: z.union([z.number(), z.string()]).nullable(),
  }),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string(),
        tokens: z.union([z.number(), z.string()]),
      }),
    )
    .nullable(),
});

const accountResponseSchema = z.object({
  account: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("apiKey") }),
      z.object({
        type: z.literal("chatgpt"),
        email: z.string().nullable(),
        planType: z.string(),
      }),
      z.object({ type: z.literal("amazonBedrock"), credentialSource: z.unknown() }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class CodexRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private readonly pending = new Map<number, Pending>();
  private stderr = "";

  constructor(private readonly executable: string) {}

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    this.child = spawn(this.executable, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`Codex app-server exited with ${code}: ${this.stderr.trim()}`));
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "agent-monitor", title: "Agent Monitor", version: "0.1.0" },
      capabilities: null,
    });
  }

  async request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) {
      if (method === "initialize") throw new Error("Codex app-server is not running");
      await this.start();
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 750)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Unknown Codex app-server error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function epochIso(value: number | null): string | null {
  if (value === null) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function windowToUsage(
  id: string,
  label: string,
  value: z.infer<typeof rateWindowSchema>,
): UsageWindow | undefined {
  if (!value) return undefined;
  const duration = value.windowDurationMins;
  const durationLabel =
    duration === null
      ? label
      : duration % 10_080 === 0
        ? `${duration / 10_080}-week`
        : duration % 1_440 === 0
          ? `${duration / 1_440}-day`
          : duration % 60 === 0
            ? `${duration / 60}-hour`
            : `${duration}-minute`;
  return {
    id,
    label: durationLabel,
    usedPercent: value.usedPercent,
    resetsAt: epochIso(value.resetsAt),
    ...(duration === null
      ? {}
      : { resetDescription: `${durationLabel} window` }),
    quality: "exact",
    category: "included",
  };
}

function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";
  readonly defaultRefreshMs: number;
  private readonly rpc: CodexRpcClient;
  private version?: string;

  constructor(
    executable = "codex",
    refreshMs = 30_000,
  ) {
    this.rpc = new CodexRpcClient(executable);
    this.defaultRefreshMs = refreshMs;
    this.executable = executable;
  }

  private readonly executable: string;

  async detect() {
    return detectVersion(this.executable);
  }

  async start(): Promise<void> {
    const detected = await this.detect();
    this.version = detected.version;
    if (detected.available) await this.rpc.start();
  }

  async stop(): Promise<void> {
    await this.rpc.stop();
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) {
      const detected = await this.detect();
      this.version = detected.version;
    }
    await this.rpc.start();
    const [ratesResult, usageResult, accountResult] = await Promise.allSettled([
      this.rpc.request("account/rateLimits/read", undefined),
      this.rpc.request("account/usage/read", undefined),
      this.rpc.request("account/read", { refreshToken: false }),
    ]);
    if (ratesResult.status === "rejected" && accountResult.status === "rejected") {
      throw ratesResult.reason;
    }

    const rates =
      ratesResult.status === "fulfilled" ? rateResponseSchema.safeParse(ratesResult.value) : undefined;
    const usage =
      usageResult.status === "fulfilled" ? usageResponseSchema.safeParse(usageResult.value) : undefined;
    const account =
      accountResult.status === "fulfilled"
        ? accountResponseSchema.safeParse(accountResult.value)
        : undefined;

    const rateSnapshot = rates?.success ? rates.data.rateLimits : undefined;
    const windows = rateSnapshot
      ? [
          windowToUsage("primary", rateSnapshot.limitName ?? "Primary", rateSnapshot.primary),
          windowToUsage("secondary", "Secondary", rateSnapshot.secondary),
        ].filter((item): item is UsageWindow => item !== undefined)
      : [];
    const summaryUsage = usage?.success ? usage.data.summary : undefined;
    const metrics: ProviderSnapshot["metrics"] = [];
    const lifetime = numeric(summaryUsage?.lifetimeTokens ?? null);
    const peak = numeric(summaryUsage?.peakDailyTokens ?? null);
    if (lifetime !== null) {
      metrics.push({
        key: "lifetime_tokens",
        label: "Lifetime tokens",
        value: lifetime,
        unit: "tokens",
        quality: "exact",
        category: "local",
      });
    }
    if (peak !== null) {
      metrics.push({
        key: "peak_daily_tokens",
        label: "Peak daily tokens",
        value: peak,
        unit: "tokens",
        quality: "exact",
        category: "local",
      });
    }
    if (rateSnapshot?.credits?.balance) {
      metrics.push({
        key: "credit_balance",
        label: "Credits",
        value: rateSnapshot.credits.balance,
        unit: "currency",
        quality: "exact",
        category: "additional",
      });
    }

    const accountData = account?.success ? account.data : undefined;
    const plan =
      accountData?.account?.type === "chatgpt"
        ? accountData.account.planType
        : rateSnapshot?.planType ?? null;
    const primary = windows[0];
    const status = rates?.success ? (usage?.success ? "ok" : "partial") : "partial";
    const message =
      accountData?.requiresOpenaiAuth === true && accountData.account === null
        ? "Codex is not authenticated"
        : rates?.success
          ? usage?.success
            ? null
            : "Token history is unavailable in this Codex version or account"
          : "Rate-limit data is unavailable";

    return {
      providerId: this.id,
      providerName: this.name,
      collectedAt: nowIso(),
      status,
      source: "structured",
      plan,
      summary:
        primary?.usedPercent !== undefined
          ? formatWindowUsage(primary)
          : lifetime !== null
            ? `${lifetime.toLocaleString()} lifetime tokens`
            : "Authenticated; usage unavailable",
      windows,
      metrics,
      message,
      version: this.version ?? null,
    };
  }
}
