import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  Metric,
  ProviderAdapter,
  ProviderSnapshot,
  ProviderSourceStatus,
  UsageWindow,
} from "../types.js";
import { nowIso } from "../types.js";
import { claudeWorkspacePath, defaultClaudeConfigDir } from "../config.js";
import { formatWindowUsage } from "../utils/format.js";
import { cleanTerminalOutput, detectVersion } from "../utils/process.js";
import {
  claudeCredentialExpired,
  readClaudeCredential,
  type ClaudeCredential,
} from "./claude-credentials.js";
import { PtySession } from "./pty-session.js";

export const claudeUsageUrl = "https://api.anthropic.com/api/oauth/usage";
export const claudeProfileUrl = "https://api.anthropic.com/api/oauth/profile";

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

const usageWindowSchema = z
  .object({
    utilization: z.number().nullable(),
    resets_at: z.string().nullable(),
  })
  .nullable()
  .optional();

const usageLimitSchema = z.object({
  kind: z.string(),
  percent: z.number().nullable(),
  resets_at: z.string().nullable().optional(),
  scope: z
    .object({
      model: z
        .object({ display_name: z.string().nullable().optional() })
        .nullable()
        .optional(),
      surface: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const usageResponseSchema = z.object({
  five_hour: usageWindowSchema,
  seven_day: usageWindowSchema,
  seven_day_opus: usageWindowSchema,
  seven_day_sonnet: usageWindowSchema,
  limits: z.array(usageLimitSchema).nullable().optional(),
  extra_usage: z
    .object({
      is_enabled: z.boolean().nullable().optional(),
      monthly_limit: z.number().nullable().optional(),
      used_credits: z.number().nullable().optional(),
      decimal_places: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const profileResponseSchema = z.object({
  organization: z
    .object({
      organization_type: z.string().nullable().optional(),
      rate_limit_tier: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface ClaudeUsage {
  windows: UsageWindow[];
  metrics: Metric[];
}

function isoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function limitIdentity(
  limit: z.infer<typeof usageLimitSchema>,
): { id: string; label: string } | undefined {
  switch (limit.kind) {
    case "session":
      return { id: "session", label: "Session" };
    case "weekly_all":
      return { id: "weekly", label: "Weekly" };
    case "weekly_scoped": {
      const name = limit.scope?.model?.display_name ?? limit.scope?.surface;
      return name ? { id: `weekly_${slug(name)}`, label: `Weekly ${name}` } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Normalize Claude's OAuth usage payload. Unknown limit kinds are ignored so
 * the monitor never invents a gauge for a value it does not understand.
 */
export function parseClaudeUsageResponse(input: unknown): ClaudeUsage | undefined {
  const parsed = usageResponseSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  if (data.limits === undefined && data.five_hour === undefined && data.seven_day === undefined) {
    return undefined;
  }
  const windows = new Map<string, UsageWindow>();
  const addWindow = (
    id: string,
    label: string,
    usedPercent: number | null | undefined,
    resetsAt: string | null | undefined,
  ): void => {
    if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) {
      return;
    }
    const reset = isoOrUndefined(resetsAt);
    windows.set(id, {
      id,
      label,
      usedPercent: Math.max(0, usedPercent),
      ...(reset ? { resetsAt: reset } : {}),
      quality: "exact",
      category: "included",
    });
  };

  if (data.limits && data.limits.length > 0) {
    for (const limit of data.limits) {
      const identity = limitIdentity(limit);
      if (identity) addWindow(identity.id, identity.label, limit.percent, limit.resets_at);
    }
  } else {
    addWindow("session", "Session", data.five_hour?.utilization, data.five_hour?.resets_at);
    addWindow("weekly", "Weekly", data.seven_day?.utilization, data.seven_day?.resets_at);
    addWindow(
      "weekly_opus",
      "Weekly Opus",
      data.seven_day_opus?.utilization,
      data.seven_day_opus?.resets_at,
    );
    addWindow(
      "weekly_sonnet",
      "Weekly Sonnet",
      data.seven_day_sonnet?.utilization,
      data.seven_day_sonnet?.resets_at,
    );
  }

  const metrics: Metric[] = [];
  const extra = data.extra_usage;
  if (extra) {
    const scale = 10 ** (extra.decimal_places ?? 2);
    if (typeof extra.used_credits === "number") {
      metrics.push({
        key: "additional_spent",
        label: "Credits spent",
        value: extra.used_credits / scale,
        unit: "currency",
        quality: "exact",
        category: "additional",
      });
    }
    if (typeof extra.monthly_limit === "number") {
      metrics.push({
        key: "additional_limit",
        label: "Monthly limit",
        value: extra.monthly_limit / scale,
        unit: "currency",
        quality: "exact",
        category: "additional",
      });
    }
    if (typeof extra.is_enabled === "boolean") {
      metrics.push({
        key: "usage_credits_status",
        label: "Usage credits",
        value: extra.is_enabled ? "on" : "off",
        unit: "text",
        quality: "exact",
        category: "additional",
      });
    }
  }

  return { windows: [...windows.values()], metrics };
}

export function claudePlanLabel(input: unknown): string | null {
  const parsed = profileResponseSchema.safeParse(input);
  if (!parsed.success) return null;
  const type = parsed.data.organization?.organization_type ?? "";
  const tier = parsed.data.organization?.rate_limit_tier ?? "";
  switch (type) {
    case "claude_max":
      return /20x/.test(tier) ? "Max 20x" : /5x/.test(tier) ? "Max 5x" : "Max";
    case "claude_pro":
      return "Pro";
    case "claude_team":
      return "Team";
    case "claude_enterprise":
      return "Enterprise";
    case "claude_free":
      return "Free";
    default:
      return null;
  }
}

export type ClaudeApiResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

async function fetchClaudeJson(
  url: string,
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<ClaudeApiResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "agent-monitor/0.1.0",
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
    if (!response.ok) {
      return { status: "error", message: `Claude usage request failed (${response.status})` };
    }
    return { status: "ok", value: await response.json() };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.name === "AbortError"
          ? "Claude usage request timed out"
          : "Claude usage request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeUsage(
  token: string,
  timeoutMs = 15_000,
  fetcher: typeof fetch = fetch,
): Promise<ClaudeApiResult<ClaudeUsage>> {
  const result = await fetchClaudeJson(claudeUsageUrl, token, timeoutMs, fetcher);
  if (result.status !== "ok") return result;
  const usage = parseClaudeUsageResponse(result.value);
  return usage
    ? { status: "ok", value: usage }
    : { status: "error", message: "Claude returned an unrecognized usage format" };
}

export async function fetchClaudePlan(
  token: string,
  timeoutMs = 15_000,
  fetcher: typeof fetch = fetch,
): Promise<ClaudeApiResult<string | null>> {
  const result = await fetchClaudeJson(claudeProfileUrl, token, timeoutMs, fetcher);
  if (result.status !== "ok") return result;
  return { status: "ok", value: claudePlanLabel(result.value) };
}

export interface ClaudeAccount {
  id: string;
  label?: string;
  configDir?: string;
}

export interface ClaudeAdapterOptions {
  executable?: string;
  refreshMs?: number;
  timeoutMs?: number;
  account?: ClaudeAccount;
  multiAccount?: boolean;
  reuseProviderCredentials?: boolean;
  workspace?: string;
  fetcher?: typeof fetch;
  credentialReader?: (configDir: string) => Promise<ClaudeCredential | undefined>;
}

const refreshCooldownMs = 10 * 60_000;

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude Code";
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly defaultRefreshMs: number;
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly configDir: string;
  private readonly reuseProviderCredentials: boolean;
  private readonly workspace: string;
  private readonly fetcher: typeof fetch;
  private readonly readCredential: (configDir: string) => Promise<ClaudeCredential | undefined>;
  private session?: PtySession;
  private version?: string;
  private plan?: string | null;
  private lastRefreshAttempt = 0;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.defaultRefreshMs = options.refreshMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const account = options.account ?? { id: "default" };
    this.configDir = resolve(account.configDir ?? defaultClaudeConfigDir());
    if (options.multiAccount) {
      this.accountId = account.id;
      this.accountLabel =
        account.label ?? account.id.charAt(0).toUpperCase() + account.id.slice(1);
    }
    this.reuseProviderCredentials = options.reuseProviderCredentials ?? true;
    this.workspace = resolve(options.workspace ?? claudeWorkspacePath());
    this.fetcher = options.fetcher ?? fetch;
    this.readCredential = options.credentialReader ?? ((dir) => readClaudeCredential(dir));
  }

  async detect() {
    const result = await detectVersion(this.executable);
    this.version = result.version;
    return result;
  }

  async stop(): Promise<void> {
    await this.session?.stop("/exit");
    this.session = undefined;
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) {
      const detected = await this.detect();
      this.version = detected.version;
    }
    if (!this.reuseProviderCredentials) {
      return this.unavailable(
        "Credential reuse disabled",
        "Set reuseProviderCredentials to true to read Claude Code's saved sign-in",
      );
    }

    let credential = await this.readCredential(this.configDir);
    if (!credential) {
      return this.unavailable("Not signed in", `Run ${this.cliHint()} and sign in`);
    }

    let result: ClaudeApiResult<ClaudeUsage> = claudeCredentialExpired(credential)
      ? { status: "unauthorized" }
      : await fetchClaudeUsage(credential.accessToken, this.timeoutMs, this.fetcher);
    if (result.status === "unauthorized" && (await this.refreshViaCli())) {
      credential = await this.readCredential(this.configDir);
      if (credential && !claudeCredentialExpired(credential)) {
        result = await fetchClaudeUsage(credential.accessToken, this.timeoutMs, this.fetcher);
      }
    }
    if (result.status === "unauthorized") {
      return this.unavailable(
        "Sign-in expired",
        `Claude Code's sign-in expired; run ${this.cliHint()} to refresh it`,
      );
    }
    if (result.status === "error") throw new Error(result.message);

    if (this.plan === undefined && credential) {
      const plan = await fetchClaudePlan(credential.accessToken, this.timeoutMs, this.fetcher);
      if (plan.status === "ok") this.plan = plan.value;
    }

    const { windows, metrics } = result.value;
    const primary = windows[0];
    const available = windows.length > 0;
    return {
      ...this.identity(),
      collectedAt: nowIso(),
      status: available ? "ok" : "partial",
      source: "api",
      plan: this.plan ?? null,
      summary:
        primary?.usedPercent !== undefined
          ? `${formatWindowUsage(primary)} in ${primary.label.toLowerCase()}`
          : "Usage limits not exposed",
      windows,
      metrics,
      message: available ? null : "Claude did not report any plan limits for this account",
      version: this.version ?? null,
      sources: [this.source(available ? "active" : "error", available ? undefined : "No limits reported")],
    };
  }

  /**
   * Claude Code refreshes its own OAuth token whenever it talks to the API.
   * Opening its usage screen headlessly is the safest way to trigger that
   * without taking over the refresh token ourselves.
   */
  private async refreshViaCli(): Promise<boolean> {
    if (Date.now() - this.lastRefreshAttempt < refreshCooldownMs) return false;
    this.lastRefreshAttempt = Date.now();
    try {
      ensureClaudeWorkspace(this.workspace);
      this.session = new PtySession(this.executable, {
        args: ["--ax-screen-reader", "--safe-mode", "--permission-mode", "plan", "--no-chrome"],
        rows: 45,
        cols: 120,
        cwd: this.workspace,
        env: { CLAUDE_CONFIG_DIR: this.configDir },
        startupTimeoutMs: this.timeoutMs,
        startupSettleMs: 1_000,
        inputDelayMs: 300,
      });
      await this.session.start();
      await this.acceptWorkspaceTrust(this.session.currentOutput());
      const output = await this.session.capture("/usage", this.timeoutMs);
      if (await this.acceptWorkspaceTrust(output)) {
        await this.session.capture("/usage", this.timeoutMs);
      }
      return true;
    } catch {
      return false;
    } finally {
      await this.stop();
    }
  }

  private async acceptWorkspaceTrust(output: string): Promise<boolean> {
    if (!this.session || !isClaudeWorkspaceTrustPrompt(output)) return false;
    const target = claudeWorkspaceTrustTarget(output);
    if (!target || resolve(target) !== this.workspace) {
      throw new Error(
        `Claude requested trust for an unexpected workspace: ${target ?? "unknown"}`,
      );
    }
    const confirmation = await this.session.capture("y", this.timeoutMs);
    if (isClaudeWorkspaceTrustPrompt(confirmation)) {
      throw new Error("Claude did not accept the controlled monitor workspace");
    }
    return true;
  }

  private cliHint(): string {
    return this.configDir === resolve(defaultClaudeConfigDir())
      ? "claude"
      : `CLAUDE_CONFIG_DIR=${this.configDir} claude`;
  }

  private identity(): Pick<
    ProviderSnapshot,
    "providerId" | "providerName" | "accountId" | "accountLabel"
  > {
    return {
      providerId: this.id,
      providerName: this.name,
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.accountLabel ? { accountLabel: this.accountLabel } : {}),
    };
  }

  private source(
    state: ProviderSourceStatus["state"],
    message?: string,
  ): ProviderSourceStatus {
    return {
      id: "claude-usage",
      label: "Plan limits",
      kind: "api",
      role: "primary",
      state,
      ...(message ? { message } : {}),
    };
  }

  private unavailable(summary: string, message: string): ProviderSnapshot {
    return {
      ...this.identity(),
      collectedAt: nowIso(),
      status: "unavailable",
      source: "api",
      plan: this.plan ?? null,
      summary,
      windows: [],
      metrics: [],
      message,
      version: this.version ?? null,
      sources: [this.source("expired", message)],
    };
  }
}
