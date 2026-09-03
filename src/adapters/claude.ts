import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  CollectionContext,
  ProviderAdapter,
  ProviderSnapshot,
  ProviderSourceStatus,
  UsageWindow,
} from "../types.js";
import { claudeWorkspacePath } from "../config.js";
import { DashboardSession, dashboardAuthStatus } from "../dashboard-auth.js";
import { formatWindowUsage } from "../utils/format.js";
import { cleanTerminalOutput, detectVersion } from "../utils/process.js";
import { parseClaudeDashboard } from "./dashboard-parsers.js";
import { PtySession } from "./pty-session.js";

const workspaceMarker = ".agent-monitor-workspace";
const workspaceMarkerContents = "Private workspace for agent-monitor's read-only Claude usage session.\n";

export function isClaudeWorkspaceTrustPrompt(raw: string): boolean {
  const text = cleanTerminalOutput(raw);
  return (
    /Permission Required:\s*Accessing workspace:/i.test(text) &&
    /Please answer y or n/i.test(text)
  );
}

export function claudeWorkspaceTrustTarget(raw: string): string | undefined {
  const text = cleanTerminalOutput(raw);
  return text
    .match(
      /Permission Required:\s*Accessing workspace:\s*([\s\S]*?)\s*Quick safety check:/i,
    )?.[1]
    ?.replace(/\s*\n\s*/g, " ")
    .trim();
}

function claudePlan(raw: string): string | null {
  return (
    cleanTerminalOutput(raw)
      .match(/\bClaude\s+(Pro|Max 5x|Max 20x|Team|Enterprise)\b/i)?.[1] ?? null
  );
}

function ensureClaudeWorkspace(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Claude monitor workspace is not a regular directory: ${path}`);
  }
  chmodSync(path, 0o700);

  const marker = join(path, workspaceMarker);
  const entries = readdirSync(path);
  if (!entries.includes(workspaceMarker)) {
    if (entries.length > 0) {
      throw new Error(
        `Refusing to trust non-empty Claude monitor workspace without its marker: ${path}`,
      );
    }
    writeFileSync(marker, workspaceMarkerContents, { encoding: "utf8", mode: 0o600 });
  } else if (readFileSync(marker, "utf8") !== workspaceMarkerContents) {
    throw new Error(`Claude monitor workspace marker is invalid: ${path}`);
  }

  const unexpected = readdirSync(path).filter((entry) => entry !== workspaceMarker);
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to trust Claude monitor workspace containing unexpected files: ${path}`,
    );
  }
}

function parseReset(line: string): string | undefined {
  return line.match(/reset(?:s|ting)?(?:\s+in|\s+at|:)?\s+(.+)$/i)?.[1]?.trim();
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function clockHour(hour: number, meridiem?: string): number {
  if (!meridiem) return hour;
  const normalized = hour % 12;
  return meridiem.toLowerCase() === "pm" ? normalized + 12 : normalized;
}

function partsInZone(date: Date, timeZone?: string): DateParts {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  } catch {
    return partsInZone(date);
  }
}

function dateInZone(parts: DateParts, timeZone?: string): Date {
  if (!timeZone) {
    return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  try {
    const desired = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    let candidate = desired;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const rendered = partsInZone(new Date(candidate), timeZone);
      const renderedAsUtc = Date.UTC(
        rendered.year,
        rendered.month - 1,
        rendered.day,
        rendered.hour,
        rendered.minute,
      );
      candidate += desired - renderedAsUtc;
    }
    return new Date(candidate);
  } catch {
    return dateInZone(parts);
  }
}

function addCalendarDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

export function parseClaudeResetAt(
  description: string,
  now = new Date(),
): string | undefined {
  const zone = description.match(/\(([^)]+\/[^)]+)\)\s*$/)?.[1];
  const value = description.replace(/\s*\([^)]+\)\s*$/, "").trim();
  const duration = value.match(
    /^(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?)?\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?$/i,
  );
  if (duration && duration.slice(1).some(Boolean)) {
    const seconds =
      Number(duration[1] ?? 0) * 86_400 +
      Number(duration[2] ?? 0) * 3_600 +
      Number(duration[3] ?? 0) * 60;
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }

  const current = partsInZone(now, zone);
  const time = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (time) {
    let targetParts: DateParts = {
      ...current,
      hour: clockHour(Number(time[1]), time[3]),
      minute: Number(time[2] ?? 0),
    };
    let target = dateInZone(targetParts, zone);
    if (target.getTime() <= now.getTime()) {
      targetParts = addCalendarDays(targetParts, 1);
      target = dateInZone(targetParts, zone);
    }
    return target.toISOString();
  }

  const calendarDate = value.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (calendarDate) {
    const month = months.findIndex((item) =>
      calendarDate[1]?.toLowerCase().startsWith(item),
    );
    if (month >= 0) {
      const explicitYear = calendarDate[3] ? Number(calendarDate[3]) : undefined;
      const targetParts: DateParts = {
        year: explicitYear ?? current.year,
        month: month + 1,
        day: Number(calendarDate[2]),
        hour: clockHour(Number(calendarDate[4]), calendarDate[6]),
        minute: Number(calendarDate[5] ?? 0),
      };
      let target = dateInZone(targetParts, zone);
      if (!explicitYear && target.getTime() <= now.getTime()) {
        target = dateInZone({ ...targetParts, year: targetParts.year + 1 }, zone);
      }
      return target.toISOString();
    }
  }

  const weekday = value.match(
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (weekday) {
    const targetWeekday = weekdays.indexOf(weekday[1]?.toLowerCase() ?? "");
    const currentCalendar = new Date(Date.UTC(current.year, current.month - 1, current.day));
    const daysAhead = (targetWeekday - currentCalendar.getUTCDay() + 7) % 7;
    let targetParts = addCalendarDays(
      {
        ...current,
        hour: clockHour(Number(weekday[2]), weekday[4]),
        minute: Number(weekday[3] ?? 0),
      },
      daysAhead,
    );
    let target = dateInZone(targetParts, zone);
    if (target.getTime() <= now.getTime()) {
      targetParts = addCalendarDays(targetParts, 7);
      target = dateInZone(targetParts, zone);
    }
    return target.toISOString();
  }

  return undefined;
}

export function parseClaudeUsage(
  raw: string,
  version?: string,
  now = new Date(),
): ProviderSnapshot {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/[│┃╭╮╰╯─━┌┐└┘]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const windows = new Map<string, UsageWindow>();
  let pendingWindow: { id: string; label: string } | undefined;
  let lastWindowId: string | undefined;
  for (const line of lines) {
    if (/^current session$/i.test(line)) {
      pendingWindow = { id: "session", label: "Session" };
      continue;
    }
    if (/^current week(?:\s+\(all models\))?$/i.test(line)) {
      pendingWindow = { id: "weekly", label: "Weekly" };
      continue;
    }
    if (/^current week.*sonnet/i.test(line)) {
      pendingWindow = { id: "sonnet", label: "Weekly Sonnet" };
      continue;
    }
    if (/^resets?\s+/i.test(line) && lastWindowId) {
      const existing = windows.get(lastWindowId);
      const resetDescription = parseReset(line);
      if (existing && resetDescription) {
        const resetsAt = parseClaudeResetAt(resetDescription, now);
        windows.set(lastWindowId, {
          ...existing,
          resetDescription,
          ...(resetsAt ? { resetsAt } : {}),
        });
      }
      pendingWindow = undefined;
      continue;
    }
    const percent = line.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i);
    if (!percent) continue;
    const usedPercent = Number(percent[1]);
    if (!Number.isFinite(usedPercent)) continue;
    let id = pendingWindow?.id;
    let label = pendingWindow?.label;
    if (/session|5[\s-]*hour/i.test(line)) {
      id = "session";
      label = "Session";
    } else if (/week|weekly|all models/i.test(line)) {
      id = "weekly";
      label = /sonnet/i.test(line) ? "Weekly Sonnet" : "Weekly";
    } else if (/sonnet/i.test(line)) {
      id = "sonnet";
      label = "Sonnet";
    }
    if (!id || !label) continue;
    const resetDescription = parseReset(line);
    const resetsAt = resetDescription ? parseClaudeResetAt(resetDescription, now) : undefined;
    const existing = windows.get(id);
    windows.set(id, {
      ...existing,
      id,
      label,
      usedPercent,
      ...(resetDescription
        ? { resetDescription }
        : existing?.resetDescription
          ? { resetDescription: existing.resetDescription }
          : {}),
      ...(resetsAt
        ? { resetsAt }
        : existing?.resetsAt
          ? { resetsAt: existing.resetsAt }
          : {}),
      quality: "exact",
      category: "included",
    });
    lastWindowId = id;
    pendingWindow = undefined;
  }

  const joined = lines.join(" ");
  const creditStatus = joined.match(/usage credits are\s+(on|off)\b/i)?.[1]?.toLowerCase();
  const extraSpent = joined.match(/([$€£]\s?[\d.,]+)\s+spent\b/i)?.[1];
  const extraLimit = joined.match(
    /([$€£]\s?[\d.,]+)\s+(?:monthly\s+)?(?:spend\s+)?limit\b/i,
  )?.[1];
  const creditBalance = joined.match(
    /([$€£]\s?[\d.,]+)\s+(?:current\s+)?balance\b|(?:current\s+)?balance.{0,20}?([$€£]\s?[\d.,]+)/i,
  );
  const currencyValue = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value.replace(/[$€£,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const loginRequired = /log in|not authenticated|authentication required/i.test(joined);
  const trustRequired = isClaudeWorkspaceTrustPrompt(raw);
  const usageWindows = [...windows.values()];
  const metrics: ProviderSnapshot["metrics"] = [];
  const spent = currencyValue(extraSpent);
  const limit = currencyValue(extraLimit);
  const balance = currencyValue(creditBalance?.[1] ?? creditBalance?.[2]);
  if (spent !== undefined) {
    metrics.push({
      key: "additional_spent",
      label: "Credits spent",
      value: spent,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (limit !== undefined) {
    metrics.push({
      key: "additional_limit",
      label: "Monthly limit",
      value: limit,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (balance !== undefined) {
    metrics.push({
      key: "credit_balance",
      label: "Credit balance",
      value: balance,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (creditStatus) {
    metrics.push({
      key: "usage_credits_status",
      label: "Usage credits",
      value: creditStatus,
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  const available = usageWindows.length > 0 || metrics.length > 0;
  const primary = usageWindows[0];

  return {
    providerId: "claude",
    providerName: "Claude Code",
    collectedAt: now.toISOString(),
    status: available
      ? "ok"
      : loginRequired || trustRequired
        ? "unavailable"
        : "partial",
    source: "cli",
    plan: claudePlan(raw),
    summary:
      primary?.usedPercent !== undefined
        ? `${formatWindowUsage(primary)} in ${primary.label.toLowerCase()}`
        : loginRequired
          ? "Not authenticated"
          : trustRequired
            ? "Workspace trust required"
          : "Usage format not recognized",
    windows: usageWindows,
    metrics,
    message: available
      ? null
      : loginRequired
        ? "Run claude and sign in"
        : trustRequired
          ? "Claude is waiting for workspace trust"
          : "Claude's /usage screen changed or did not expose subscription limits",
    version: version ?? null,
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude Code";
  readonly defaultRefreshMs: number;
  private readonly session: PtySession;
  private readonly dashboard: DashboardSession;
  private readonly workspace: string;
  private version?: string;
  private plan?: string;

  constructor(
    private readonly executable = "claude",
    refreshMs = 60_000,
    private readonly timeoutMs = 15_000,
    workspace = claudeWorkspacePath(),
  ) {
    this.defaultRefreshMs = refreshMs;
    this.workspace = resolve(workspace);
    this.dashboard = new DashboardSession("claude", timeoutMs);
    this.session = new PtySession(executable, {
      args: [
        "--ax-screen-reader",
        "--safe-mode",
        "--permission-mode",
        "plan",
        "--no-chrome",
      ],
      rows: 45,
      cols: 120,
      cwd: this.workspace,
      startupTimeoutMs: timeoutMs,
      startupSettleMs: 1_000,
      inputDelayMs: 300,
    });
  }

  async detect() {
    const result = await detectVersion(this.executable);
    this.version = result.version;
    return result;
  }

  async start(): Promise<void> {
    const detected = await this.detect();
    if (detected.available) await this.prepareSession();
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.session.stop("/exit"),
      this.dashboard.stop(),
    ]);
  }

  async collect(context?: CollectionContext): Promise<ProviderSnapshot> {
    if (!this.version) {
      const detected = await this.detect();
      this.version = detected.version;
    }
    await this.prepareSession();
    const [output, dashboardResult] = await Promise.all([
      this.captureUsage(),
      this.dashboard.read(context?.force),
    ]);
    const parsedCli = parseClaudeUsage(output, this.version);
    if (parsedCli.plan) this.plan = parsedCli.plan;
    const cli = {
      ...parsedCli,
      plan: parsedCli.plan ?? this.plan ?? null,
    };
    const dashboardConnection = dashboardAuthStatus("claude");
    const cliSource: ProviderSourceStatus = {
      id: "claude-usage",
      label: "Plan limits",
      kind: "cli",
      role: "primary",
      state: cli.status === "ok" ? "active" : "error",
      message: cli.message,
    };
    if (dashboardResult.status !== "ok") {
      const dashboardSource: ProviderSourceStatus = {
        id: "claude-billing",
        label: "Billing details",
        kind: "browser",
        role: "optional",
        state:
          dashboardResult.status === "not-configured"
            ? "available"
            : dashboardResult.status === "authentication-required"
              ? "expired"
              : "error",
        message: dashboardResult.message,
        action:
          dashboardResult.status === "authentication-required"
            ? "reconnect-dashboard"
            : "connect-dashboard",
      };
      return {
        ...cli,
        status: cli.status,
        message: cli.message,
        sources: [cliSource, dashboardSource],
      };
    }
    const dashboard = parseClaudeDashboard(dashboardResult.text);
    if (!dashboard) {
      return {
        ...cli,
        status: cli.status,
        message: cli.message,
        sources: [
          cliSource,
          {
            id: "claude-billing",
            label: "Billing details",
            kind: "browser",
            role: "optional",
            state: "error",
            message: "Dashboard format was not recognized",
            action: dashboardConnection.configured
              ? "reconnect-dashboard"
              : "connect-dashboard",
          },
        ],
      };
    }
    const includedWindows = cli.windows.filter((window) => window.category !== "additional");
    const cliNonAdditional = cli.metrics.filter((metric) => metric.category !== "additional");
    return {
      ...cli,
      status: includedWindows.length > 0 ? "ok" : "partial",
      source: "hybrid",
      windows: [...includedWindows, ...dashboard.windows],
      metrics: [...dashboard.metrics, ...cliNonAdditional],
      message: cli.message,
      sources: [
        cliSource,
        {
          id: "claude-billing",
          label: "Billing details",
          kind: "browser",
          role: "optional",
          state: "active",
        },
      ],
    };
  }

  private async prepareSession(): Promise<void> {
    ensureClaudeWorkspace(this.workspace);
    await this.session.start();
    await this.acceptWorkspaceTrust(this.session.currentOutput());
  }

  private async captureUsage(): Promise<string> {
    let output = await this.session.capture("/usage", this.timeoutMs);
    if (await this.acceptWorkspaceTrust(output)) {
      output = await this.session.capture("/usage", this.timeoutMs);
    }
    return output;
  }

  private async acceptWorkspaceTrust(output: string): Promise<boolean> {
    this.rememberPlan(output);
    if (!isClaudeWorkspaceTrustPrompt(output)) return false;
    const target = claudeWorkspaceTrustTarget(output);
    if (!target || resolve(target) !== this.workspace) {
      throw new Error(
        `Claude requested trust for an unexpected workspace: ${target ?? "unknown"}`,
      );
    }

    const confirmation = await this.session.capture("y", this.timeoutMs);
    this.rememberPlan(confirmation);
    if (isClaudeWorkspaceTrustPrompt(confirmation)) {
      throw new Error("Claude did not accept the controlled monitor workspace");
    }
    return true;
  }

  private rememberPlan(output: string): void {
    this.plan = claudePlan(output) ?? this.plan;
  }
}
