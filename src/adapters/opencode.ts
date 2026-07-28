import type { ProviderAdapter, ProviderSnapshot } from "../types.js";
import { nowIso } from "../types.js";
import { formatWindowUsage } from "../utils/format.js";
import { cleanTerminalOutput, detectVersion, runCommand } from "../utils/process.js";
import { DashboardSession } from "../dashboard-auth.js";
import { parseOpenCodeDashboard } from "./dashboard-parsers.js";

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

  constructor(
    private readonly executable = "opencode",
    refreshMs = 30_000,
    private readonly timeoutMs = 15_000,
  ) {
    this.defaultRefreshMs = refreshMs;
    this.dashboard = new DashboardSession("opencode", timeoutMs);
  }

  async detect() {
    const result = await detectVersion(this.executable);
    this.version = result.version;
    return result;
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) await this.detect();
    const [stats, account, dashboardResult] = await Promise.all([
      runCommand(
        this.executable,
        ["stats", "--days", "1", "--models", "10"],
        { timeoutMs: this.timeoutMs, env: { ...process.env, NO_COLOR: "1" } },
      ),
      runCommand(this.executable, ["auth", "list"], {
        timeoutMs: this.timeoutMs,
        env: { ...process.env, NO_COLOR: "1" },
      }),
      this.dashboard.read(),
    ]);
    if (stats.timedOut || account.timedOut) throw new Error("OpenCode account check timed out");
    if (stats.exitCode !== 0) {
      throw new Error(cleanTerminalOutput(stats.stderr || stats.stdout) || "OpenCode stats failed");
    }
    const local = parseOpenCodeStats(
      stats.stdout,
      this.version,
      `${account.stdout}\n${account.stderr}`,
    );
    if (dashboardResult.status !== "ok") {
      return {
        ...local,
        status: local.plan === "Go" ? "partial" : local.status,
        message: local.plan === "Go" ? dashboardResult.message : local.message,
      };
    }
    const dashboard = parseOpenCodeDashboard(dashboardResult.text);
    if (!dashboard) {
      return {
        ...local,
        status: "partial",
        message: "OpenCode dashboard format was not recognized; local activity is still available",
      };
    }
    const primary = dashboard.windows[0];
    return {
      ...local,
      status: dashboard.windows.length > 0 ? "ok" : "partial",
      source: "hybrid",
      plan: dashboard.plan ?? local.plan,
      summary:
        primary?.usedPercent === undefined
          ? local.summary
          : `${formatWindowUsage(primary)} in ${primary.label.toLowerCase()}`,
      windows: dashboard.windows,
      metrics: [...dashboard.metrics, ...local.metrics],
      message: null,
    };
  }

  async stop(): Promise<void> {
    await this.dashboard.stop();
  }
}
