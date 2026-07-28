import type { ProviderAdapter, ProviderSnapshot } from "../types.js";
import { DashboardSession } from "../dashboard-auth.js";
import { nowIso } from "../types.js";
import { formatWindowUsage } from "../utils/format.js";
import { cleanTerminalOutput, detectVersion, runCommand } from "../utils/process.js";
import { parseCursorDashboard } from "./dashboard-parsers.js";

export function parseCursorAbout(raw: string, version?: string): ProviderSnapshot {
  const text = cleanTerminalOutput(raw);
  const plan = text.match(/Subscription Tier\s+(.+)/i)?.[1]?.trim() ?? null;
  const loggedIn =
    /Login successful|Logged in/i.test(text) &&
    !/Not logged in|unable to fetch user details/i.test(text);
  const partialLogin = /Login successful|Logged in/i.test(text);
  return {
    providerId: "cursor",
    providerName: "Cursor",
    collectedAt: nowIso(),
    status: partialLogin ? "partial" : "unavailable",
    source: "cli",
    plan: plan && plan.toLowerCase() !== "unknown" ? plan : null,
    summary: partialLogin ? "Account detected · usage unavailable" : "Not authenticated",
    windows: [],
    metrics: [],
    message: partialLogin
      ? "Personal usage is not exposed by Cursor's supported CLI; team usage requires an Admin API key"
      : "Run cursor-agent login to authenticate",
    version: version ?? null,
  };
}

export class CursorAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;
  readonly name = "Cursor";
  readonly defaultRefreshMs: number;
  private version?: string;
  private readonly dashboard: DashboardSession;

  constructor(
    private readonly executable = "cursor-agent",
    refreshMs = 300_000,
    private readonly timeoutMs = 15_000,
  ) {
    this.defaultRefreshMs = refreshMs;
    this.dashboard = new DashboardSession("cursor", timeoutMs);
  }

  async detect() {
    const result = await detectVersion(this.executable, ["--version"]);
    this.version = result.version;
    return result;
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) await this.detect();
    const [status, about, dashboardResult] = await Promise.all([
      runCommand(this.executable, ["status"], { timeoutMs: this.timeoutMs }),
      runCommand(this.executable, ["about"], { timeoutMs: this.timeoutMs }),
      this.dashboard.read(),
    ]);
    if (status.timedOut || about.timedOut) throw new Error("Cursor account check timed out");
    const output = `${status.stdout}\n${status.stderr}\n${about.stdout}\n${about.stderr}`;
    const cli = parseCursorAbout(output, this.version);
    if (dashboardResult.status !== "ok") {
      return {
        ...cli,
        message: dashboardResult.message,
      };
    }
    const dashboard = parseCursorDashboard(dashboardResult.text);
    if (!dashboard) {
      return {
        ...cli,
        message: "Cursor dashboard format was not recognized",
      };
    }
    const primary = dashboard.windows[0];
    return {
      ...cli,
      status: primary ? "ok" : "partial",
      source: "hybrid",
      plan: dashboard.plan ?? cli.plan,
      summary:
        primary?.usedPercent === undefined
          ? cli.summary
          : formatWindowUsage(primary),
      windows: dashboard.windows,
      metrics: dashboard.metrics,
      message:
        dashboard.windows.length > 0 || dashboard.metrics.length > 0
          ? null
          : "Cursor plan detected; usage format was not recognized",
    };
  }

  async stop(): Promise<void> {
    await this.dashboard.stop();
  }
}
