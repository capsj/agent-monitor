import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Metric, ProviderAdapter, ProviderSnapshot, UsageWindow } from "../types.js";
import { nowIso } from "../types.js";
import { cursorStatePath } from "../config.js";
import { formatWindowUsage } from "../utils/format.js";

const execFileAsync = promisify(execFile);

export const cursorUsageSummaryUrl = "https://cursor.com/api/usage-summary";
export const cursorSubscriptionUrl = "https://cursor.com/api/auth/stripe";

/**
 * Read the dashboard session token the Cursor app keeps in its local state
 * database. The database is opened read-only; the token stays in memory and is
 * only sent to cursor.com.
 */
export function readCursorSessionToken(path = cursorStatePath()): string | undefined {
  if (!existsSync(path)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/accessToken") as { value?: unknown } | undefined;
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    return value || undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function cursorUserId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    if (typeof claims.sub !== "string") return undefined;
    const id = claims.sub.split("|").pop();
    return id || undefined;
  } catch {
    return undefined;
  }
}

const usageSummarySchema = z.object({
  billingCycleStart: z.string().nullable().optional(),
  billingCycleEnd: z.string().nullable().optional(),
  membershipType: z.string().nullable().optional(),
  individualUsage: z
    .object({
      plan: z
        .object({
          enabled: z.boolean().nullable().optional(),
          used: z.number().nullable().optional(),
          limit: z.number().nullable().optional(),
          autoPercentUsed: z.number().nullable().optional(),
          apiPercentUsed: z.number().nullable().optional(),
          totalPercentUsed: z.number().nullable().optional(),
          breakdown: z
            .object({ bonus: z.number().nullable().optional() })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
      onDemand: z
        .object({
          enabled: z.boolean().nullable().optional(),
          used: z.number().nullable().optional(),
          limit: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const subscriptionSchema = z.object({
  membershipType: z.string().nullable().optional(),
  individualMembershipType: z.string().nullable().optional(),
  teamMembershipType: z.string().nullable().optional(),
  subscriptionStatus: z.string().nullable().optional(),
  isYearlyPlan: z.boolean().nullable().optional(),
});

export interface CursorUsage {
  plan: string | null;
  windows: UsageWindow[];
  metrics: Metric[];
}

function planLabel(value: string | null | undefined): string | null {
  if (!value || value === "unknown") return null;
  return value
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const time = Number.isFinite(numeric) ? numeric : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * Normalize Cursor's dashboard usage summary. Cursor reports plan usage in
 * cents, so monetary values are converted to dollars here.
 */
export function parseCursorUsage(summaryInput: unknown, subscriptionInput?: unknown): CursorUsage | undefined {
  const summary = usageSummarySchema.safeParse(summaryInput);
  if (!summary.success || summary.data.individualUsage === undefined) return undefined;
  const subscription = subscriptionSchema.safeParse(subscriptionInput ?? {});
  const plan = summary.data.individualUsage?.plan;
  const onDemand = summary.data.individualUsage?.onDemand;
  const resetsAt = isoOrUndefined(summary.data.billingCycleEnd);
  const windows: UsageWindow[] = [];
  const addWindow = (id: string, label: string, usedPercent: number | null | undefined): void => {
    if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return;
    windows.push({
      id,
      label,
      usedPercent: Math.max(0, usedPercent),
      ...(resetsAt ? { resetsAt, resetDescription: "billing cycle" } : {}),
      quality: "exact",
      category: "included",
    });
  };
  if (plan?.enabled !== false) {
    addWindow("monthly_auto_models", "Auto models", plan?.autoPercentUsed);
    addWindow("monthly_other_models", "Other models", plan?.apiPercentUsed);
  }

  const metrics: Metric[] = [];
  if (typeof plan?.used === "number" && typeof plan.limit === "number" && plan.limit > 0) {
    metrics.push({
      key: "included_spent",
      label: "Included used",
      value: plan.used / 100,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
    metrics.push({
      key: "included_limit",
      label: "Included limit",
      value: plan.limit / 100,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (typeof plan?.breakdown?.bonus === "number" && plan.breakdown.bonus > 0) {
    metrics.push({
      key: "bonus_usage",
      label: "Bonus usage",
      value: plan.breakdown.bonus / 100,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (typeof onDemand?.enabled === "boolean") {
    metrics.push({
      key: "on_demand_status",
      label: "On-demand",
      value: onDemand.enabled ? "enabled" : "disabled",
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  if (onDemand?.enabled && typeof onDemand.used === "number") {
    metrics.push({
      key: "on_demand_spent",
      label: "On-demand spent",
      value: onDemand.used / 100,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
    if (typeof onDemand.limit === "number" && onDemand.limit > 0) {
      windows.push({
        id: "on_demand",
        label: "On-demand",
        usedPercent: Math.max(0, (onDemand.used / onDemand.limit) * 100),
        ...(resetsAt ? { resetsAt, resetDescription: "billing cycle" } : {}),
        quality: "exact",
        category: "additional",
      });
    }
  }

  const membership = subscription.success
    ? subscription.data.teamMembershipType ??
      subscription.data.individualMembershipType ??
      subscription.data.membershipType
    : undefined;
  const yearly = subscription.success && subscription.data.isYearlyPlan ? " (yearly)" : "";
  const label = planLabel(membership ?? summary.data.membershipType);
  return { plan: label ? `${label}${yearly}` : null, windows, metrics };
}

export type CursorApiResult =
  | { status: "ok"; usage: CursorUsage }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

async function fetchCursorJson(
  url: string,
  cookie: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetcher(url, {
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "User-Agent": "agent-monitor/0.1.0",
      },
      signal: controller.signal,
      redirect: "manual",
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCursorUsage(
  token: string,
  timeoutMs = 15_000,
  fetcher: typeof fetch = fetch,
): Promise<CursorApiResult> {
  const userId = cursorUserId(token);
  if (!userId) return { status: "error", message: "Cursor session token was not recognized" };
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
  try {
    const [summary, subscription] = await Promise.all([
      fetchCursorJson(cursorUsageSummaryUrl, cookie, timeoutMs, fetcher),
      fetchCursorJson(cursorSubscriptionUrl, cookie, timeoutMs, fetcher).catch(() => undefined),
    ]);
    if (summary.status === 401 || summary.status === 403) return { status: "unauthorized" };
    if (summary.status < 200 || summary.status >= 300) {
      return { status: "error", message: `Cursor usage request failed (${summary.status})` };
    }
    const usage = parseCursorUsage(
      summary.body,
      subscription && subscription.status >= 200 && subscription.status < 300
        ? subscription.body
        : undefined,
    );
    if (!usage) return { status: "error", message: "Cursor returned an unrecognized usage format" };
    return { status: "ok", usage };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.name === "AbortError"
          ? "Cursor usage request timed out"
          : "Cursor usage request failed",
    };
  }
}

async function cursorAppVersion(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const result = await execFileAsync(
      "/usr/bin/defaults",
      ["read", "/Applications/Cursor.app/Contents/Info.plist", "CFBundleShortVersionString"],
      { timeout: 5_000, encoding: "utf8" },
    );
    const version = String(result.stdout).trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

export class CursorAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;
  readonly name = "Cursor";
  readonly defaultRefreshMs: number;
  private version?: string;

  constructor(
    refreshMs = 300_000,
    private readonly timeoutMs = 15_000,
    private readonly reuseProviderCredentials = true,
    private readonly statePath = cursorStatePath(),
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.defaultRefreshMs = refreshMs;
  }

  async detect() {
    this.version = await cursorAppVersion();
    if (!existsSync(this.statePath)) {
      return { available: false, message: "Cursor app state was not found; install and sign in to Cursor" };
    }
    const authenticated = readCursorSessionToken(this.statePath) !== undefined;
    return {
      available: true,
      authenticated,
      ...(this.version ? { version: this.version } : {}),
      ...(authenticated ? {} : { message: "Sign in to Cursor to expose usage" }),
    };
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) await this.detect();
    if (!this.reuseProviderCredentials) {
      return this.unavailable(
        "Credential reuse disabled",
        "Set reuseProviderCredentials to true to read Cursor's saved sign-in",
      );
    }
    const token = readCursorSessionToken(this.statePath);
    if (!token) return this.unavailable("Not signed in", "Sign in to the Cursor app to expose usage");
    const result = await fetchCursorUsage(token, this.timeoutMs, this.fetcher);
    if (result.status === "unauthorized") {
      return this.unavailable("Sign-in expired", "Cursor's sign-in expired; open Cursor and sign in again");
    }
    if (result.status === "error") throw new Error(result.message);
    const { plan, windows, metrics } = result.usage;
    const primary = windows.find((window) => window.category !== "additional");
    return {
      providerId: this.id,
      providerName: this.name,
      collectedAt: nowIso(),
      status: primary ? "ok" : "partial",
      source: "api",
      plan,
      summary: primary ? formatWindowUsage(primary) : "Usage limits not exposed",
      windows,
      metrics,
      message: primary ? null : "Cursor did not report included usage for this account",
      version: this.version ?? null,
      sources: [
        {
          id: "cursor-usage",
          label: "Personal usage",
          kind: "api",
          role: "primary",
          state: primary ? "active" : "error",
        },
      ],
    };
  }

  private unavailable(summary: string, message: string): ProviderSnapshot {
    return {
      providerId: this.id,
      providerName: this.name,
      collectedAt: nowIso(),
      status: "unavailable",
      source: "api",
      plan: null,
      summary,
      windows: [],
      metrics: [],
      message,
      version: this.version ?? null,
      sources: [
        {
          id: "cursor-usage",
          label: "Personal usage",
          kind: "api",
          role: "primary",
          state: "expired",
          message,
        },
      ],
    };
  }
}
