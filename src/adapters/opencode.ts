import { readFileSync } from "node:fs";
import { z } from "zod";
import { opencodeAuthPath } from "../config.js";
import type {
  CollectionContext,
  ProviderAdapter,
  ProviderSnapshot,
  ProviderSourceStatus,
  UsageWindow,
} from "../types.js";
import { nowIso } from "../types.js";
import { formatWindowUsage } from "../utils/format.js";
import { cleanTerminalOutput, detectVersion, runCommand } from "../utils/process.js";
import { DashboardSession, dashboardAuthStatus } from "../dashboard-auth.js";
import { parseOpenCodeDashboard } from "./dashboard-parsers.js";

const openCodeGoUsageSchema = z.object({
  usage: z.object({
    rolling: z.object({
      status: z.enum(["ok", "rate-limited"]),
      percent: z.number(),
      resetsAt: z.string().datetime(),
    }),
    weekly: z.object({
      status: z.enum(["ok", "rate-limited"]),
      percent: z.number(),
      resetsAt: z.string().datetime(),
    }),
    monthly: z.object({
      status: z.enum(["ok", "rate-limited"]),
      percent: z.number(),
      resetsAt: z.string().datetime(),
    }),
  }),
});

interface OpenCodeGoUsage {
  windows: UsageWindow[];
}

export function readOpenCodeGoKey(path = opencodeAuthPath()): string | undefined {
  try {
    const input = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const parsed = z
      .object({ type: z.string(), key: z.string() })
      .passthrough()
      .safeParse((input as Record<string, unknown>)["opencode-go"]);
    if (!parsed.success) return undefined;
    const credential = parsed.data;
    return credential?.type === "api" && credential.key.trim()
      ? credential.key
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenCodeGoUsage(input: unknown): OpenCodeGoUsage | undefined {
  const parsed = openCodeGoUsageSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const labels = {
    rolling: "Rolling Usage",
    weekly: "Weekly Usage",
    monthly: "Monthly Usage",
  } as const;
  return {
    windows: Object.entries(parsed.data.usage).map(([id, value]) => ({
      id,
      label: labels[id as keyof typeof labels],
      usedPercent: value.status === "rate-limited" ? 100 : value.percent,
      resetsAt: value.resetsAt,
      quality: "exact",
      category: "included",
    })),
  };
}

export async function fetchOpenCodeGoUsage(
  key: string,
  timeoutMs = 15_000,
  fetcher: typeof fetch = fetch,
): Promise<
  | { status: "ok"; usage: OpenCodeGoUsage }
  | { status: "error"; message: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetcher("https://opencode.ai/zen/go/v1/usage", {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "agent-monitor/0.1.0",
      },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return { status: "error", message: "OpenCode Go credential was rejected; reconnect it in OpenCode" };
    }
    if (response.status === 403) {
      return { status: "error", message: "OpenCode Go subscription usage is unavailable for this credential" };
    }
    if (!response.ok) {
      return { status: "error", message: `OpenCode Go usage request failed (${response.status})` };
    }
    const usage = parseOpenCodeGoUsage(await response.json());
    if (!usage) {
      return { status: "error", message: "OpenCode Go returned an unrecognized usage format" };
    }
    return { status: "ok", usage };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.name === "AbortError"
          ? "OpenCode Go usage request timed out"
          : "OpenCode Go usage request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseNumber(value: string): number {
  const normalized = value.replace(/,/g, "").trim();
  const match = normalized.match(/^(-?[\d.]+)\s*([KMB])?$/i);
  if (!match) return Number.NaN;
  const number = Number(match[1]);
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
    (match[2]?.toUpperCase() ?? "") as "K"
  ] ?? 1;
  return number * multiplier;
}

function field(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`${escaped}\\s+([^\\s│┐┘]+)`, "i"))?.[1];
}

export function parseOpenCodeStats(
  raw: string,
  version?: string,
  accountRaw = "",
): ProviderSnapshot {
  const text = cleanTerminalOutput(raw);
  const accountText = cleanTerminalOutput(accountRaw);
  const sessions = parseNumber(field(text, "Sessions") ?? "");
  const messages = parseNumber(field(text, "Messages") ?? "");
  const totalCost = Number((field(text, "Total Cost") ?? "").replace(/[$€£]/g, ""));
  const input = parseNumber(field(text, "Input") ?? "");
  const output = parseNumber(field(text, "Output") ?? "");
  const cacheRead = parseNumber(field(text, "Cache Read") ?? "");
  const cacheWrite = parseNumber(field(text, "Cache Write") ?? "");
  const totalTokens = [input, output, cacheRead, cacheWrite]
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);

  const metrics: ProviderSnapshot["metrics"] = [];
  if (Number.isFinite(sessions)) {
    metrics.push({
      key: "sessions",
      label: "Sessions",
      value: sessions,
      unit: "count",
      quality: "exact",
      period: "today",
      category: "local",
    });
  }
  if (Number.isFinite(messages)) {
    metrics.push({
      key: "messages",
      label: "Messages",
      value: messages,
      unit: "count",
      quality: "exact",
      period: "today",
      category: "local",
    });
  }
  if (Number.isFinite(totalCost)) {
    metrics.push({
      key: "estimated_cost",
      label: "Estimated cost",
      value: totalCost,
      unit: "currency",
      quality: "estimated",
      period: "today",
      category: "local",
    });
  }
  if (totalTokens > 0) {
    metrics.push({
      key: "tokens",
      label: "Tokens",
      value: totalTokens,
      unit: "tokens",
      quality: "exact",
      period: "today",
      category: "local",
    });
  }
  for (const [key, label, value] of [
    ["input_tokens", "Input", input],
    ["output_tokens", "Output", output],
    ["cache_read_tokens", "Cache read", cacheRead],
    ["cache_write_tokens", "Cache write", cacheWrite],
  ] as const) {
    if (Number.isFinite(value)) {
      metrics.push({
        key,
        label,
        value,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      });
    }
  }

  const available = metrics.length > 0;
  return {
    providerId: "opencode",
    providerName: "OpenCode",
    collectedAt: nowIso(),
    status: available ? "ok" : "partial",
    source: "local",
    plan: /OpenCode Go/i.test(accountText) ? "Go" : null,
    summary: Number.isFinite(totalCost)
      ? `Local estimate $${totalCost.toFixed(2)} today · ${Number.isFinite(sessions) ? sessions : 0} ${
          sessions === 1 ? "session" : "sessions"
        }`
      : available
        ? `${totalTokens.toLocaleString()} tokens today`
        : "Local stats unavailable",
    windows: [],
    metrics,
    message: available ? null : "OpenCode returned an unrecognized stats format",
    version: version ?? null,
  };
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  readonly defaultRefreshMs: number;
  private version?: string;
  private readonly dashboard: DashboardSession;
  private apiCache?: { at: number; usage: OpenCodeGoUsage };

  constructor(
    private readonly executable = "opencode",
    refreshMs = 30_000,
    private readonly timeoutMs = 15_000,
    private readonly reuseProviderCredentials = true,
    private readonly authPath = opencodeAuthPath(),
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.defaultRefreshMs = refreshMs;
    this.dashboard = new DashboardSession("opencode", timeoutMs);
  }

  async detect() {
    const result = await detectVersion(this.executable);
    this.version = result.version;
    return result;
  }

  async collect(context?: CollectionContext): Promise<ProviderSnapshot> {
    if (!this.version) await this.detect();
    const key = this.reuseProviderCredentials
      ? readOpenCodeGoKey(this.authPath)
      : undefined;
    const [stats, account, apiResult, dashboardResult] = await Promise.all([
      runCommand(
        this.executable,
        ["stats", "--days", "1", "--models", "10"],
        { timeoutMs: this.timeoutMs, env: { ...process.env, NO_COLOR: "1" } },
      ),
      runCommand(this.executable, ["auth", "list"], {
        timeoutMs: this.timeoutMs,
        env: { ...process.env, NO_COLOR: "1" },
      }),
      key
        ? this.readGoUsage(key, context?.force)
        : Promise.resolve({ status: "not-configured" as const }),
      this.dashboard.read(context?.force),
    ]);
    const accountOutput = `${account.stdout}\n${account.stderr}`;
    const localFailure = stats.timedOut
      ? "OpenCode local stats timed out"
      : stats.exitCode !== 0
        ? cleanTerminalOutput(stats.stderr || stats.stdout) || "OpenCode local stats failed"
        : undefined;
    const local = localFailure
      ? {
          providerId: "opencode" as const,
          providerName: "OpenCode",
          collectedAt: nowIso(),
          status: "partial" as const,
          source: "local" as const,
          plan: /OpenCode Go/i.test(cleanTerminalOutput(accountOutput)) ? "Go" : null,
          summary: "Local stats unavailable",
          windows: [],
          metrics: [],
          message: localFailure,
          version: this.version ?? null,
        }
      : parseOpenCodeStats(stats.stdout, this.version, accountOutput);
    const dashboard =
      dashboardResult.status === "ok"
        ? parseOpenCodeDashboard(dashboardResult.text)
        : undefined;
    const remoteWindows =
      apiResult.status === "ok"
        ? apiResult.usage.windows
        : dashboard?.windows ?? [];
    const primary = remoteWindows[0];
    const configured = dashboardAuthStatus("opencode").configured;
    const sources: ProviderSourceStatus[] = [
      {
        id: "opencode-local",
        label: "Local activity",
        kind: "local",
        role: "primary",
        state: local.status === "ok" ? "active" : "error",
        message: local.message,
      },
    ];
    if (key) {
      sources.push({
        id: "opencode-go-usage",
        label: "Go limits",
        kind: "api",
        role: "primary",
        state: apiResult.status === "ok" ? "active" : "error",
        ...(apiResult.status === "error" ? { message: apiResult.message } : {}),
      });
    }
    sources.push({
      id: "opencode-billing",
      label: "Billing balance",
      kind: "browser",
      role: key ? "optional" : "primary",
      state: dashboard
        ? "active"
        : dashboardResult.status === "not-configured"
          ? "available"
          : dashboardResult.status === "authentication-required"
            ? "expired"
            : "error",
      message: dashboard
        ? undefined
        : dashboardResult.status === "ok"
          ? "Dashboard format was not recognized"
          : dashboardResult.message,
      action: dashboard
        ? undefined
        : configured
          ? "reconnect-dashboard"
          : "connect-dashboard",
    });
    const hasGoPlan = local.plan === "Go" || Boolean(key) || remoteWindows.length > 0;
    const remoteMessage =
      apiResult.status === "error"
        ? apiResult.message
        : dashboardResult.status !== "ok" && !key
          ? dashboardResult.message
          : dashboardResult.status === "ok" && !dashboard && !key
            ? "OpenCode dashboard format was not recognized"
            : undefined;
    return {
      ...local,
      status: remoteWindows.length > 0 ? "ok" : hasGoPlan ? "partial" : local.status,
      source: apiResult.status === "ok" || dashboard ? "hybrid" : local.source,
      plan: dashboard?.plan ?? (hasGoPlan ? "Go" : local.plan),
      summary:
        primary?.usedPercent === undefined
          ? local.summary
          : `${formatWindowUsage(primary)} in ${primary.label.toLowerCase()}`,
      windows: remoteWindows,
      metrics: [...(dashboard?.metrics ?? []), ...local.metrics],
      message: remoteWindows.length > 0 ? local.message : remoteMessage ?? local.message,
      sources,
    };
  }

  private async readGoUsage(
    key: string,
    force = false,
  ): Promise<
    | { status: "ok"; usage: OpenCodeGoUsage }
    | { status: "error"; message: string }
  > {
    if (force) this.apiCache = undefined;
    if (!force && this.apiCache && Date.now() - this.apiCache.at < 60_000) {
      return { status: "ok", usage: this.apiCache.usage };
    }
    const result = await fetchOpenCodeGoUsage(key, this.timeoutMs, this.fetcher);
    if (result.status === "ok") {
      const usage = result.usage;
      this.apiCache = { at: Date.now(), usage };
      return { status: "ok", usage };
    }
    return result;
  }

  async stop(): Promise<void> {
    await this.dashboard.stop();
    this.apiCache = undefined;
  }
}
