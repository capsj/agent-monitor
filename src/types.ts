import { z } from "zod";

export const providerIds = ["codex", "claude", "cursor", "opencode", "gemini"] as const;
export type ProviderId = (typeof providerIds)[number];

export const snapshotStatusSchema = z.enum([
  "ok",
  "partial",
  "unavailable",
  "stale",
  "error",
]);
export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;

export const metricQualitySchema = z.enum([
  "exact",
  "estimated",
  "partial",
  "unavailable",
  "stale",
]);
export type MetricQuality = z.infer<typeof metricQualitySchema>;

export const metricUnitSchema = z.enum([
  "percent",
  "count",
  "tokens",
  "currency",
  "duration",
  "timestamp",
  "text",
]);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

export const usageCategorySchema = z.enum(["included", "additional", "local"]);
export type UsageCategory = z.infer<typeof usageCategorySchema>;

export const providerSourceKindSchema = z.enum([
  "structured",
  "cli",
  "local",
  "api",
]);
export type ProviderSourceKind = z.infer<typeof providerSourceKindSchema>;

export const providerSourceStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: providerSourceKindSchema,
  role: z.enum(["primary", "optional"]),
  state: z.enum(["active", "available", "action-required", "expired", "error"]),
  message: z.string().nullable().optional(),
});
export type ProviderSourceStatus = z.infer<typeof providerSourceStatusSchema>;

export const metricSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string(), z.null()]),
  unit: metricUnitSchema,
  quality: metricQualitySchema.default("exact"),
  period: z.string().optional(),
  category: usageCategorySchema.optional(),
});
export type Metric = z.infer<typeof metricSchema>;

export const usageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().min(0).optional(),
  remaining: z.number().optional(),
  limit: z.number().optional(),
  resetsAt: z.string().datetime().nullable().optional(),
  resetDescription: z.string().optional(),
  quality: metricQualitySchema.default("exact"),
  category: usageCategorySchema.optional(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const providerSnapshotSchema = z.object({
  providerId: z.enum(providerIds),
  providerName: z.string(),
  accountId: z.string().optional(),
  accountLabel: z.string().optional(),
  collectedAt: z.string().datetime(),
  status: snapshotStatusSchema,
  source: z.enum(["structured", "cli", "local", "api", "hybrid"]),
  plan: z.string().nullable().optional(),
  summary: z.string(),
  windows: z.array(usageWindowSchema).default([]),
  metrics: z.array(metricSchema).default([]),
  message: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  sources: z.array(providerSourceStatusSchema).optional(),
});
export type ProviderSnapshot = z.infer<typeof providerSnapshotSchema>;

/**
 * Snapshots are keyed by provider, or by `provider:account` when a provider is
 * configured with several accounts.
 */
export function snapshotKey(
  snapshot: Pick<ProviderSnapshot, "providerId" | "accountId">,
): string {
  return snapshot.accountId ? `${snapshot.providerId}:${snapshot.accountId}` : snapshot.providerId;
}

export function displayName(
  snapshot: Pick<ProviderSnapshot, "providerName" | "accountLabel">,
): string {
  return snapshot.accountLabel
    ? `${snapshot.providerName} · ${snapshot.accountLabel}`
    : snapshot.providerName;
}

export interface DetectionResult {
  available: boolean;
  authenticated?: boolean;
  version?: string;
  message?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly defaultRefreshMs: number;
  detect(): Promise<DetectionResult>;
  start?(): Promise<void>;
  collect(context?: CollectionContext): Promise<ProviderSnapshot>;
  stop?(): Promise<void>;
}

export interface CollectionContext {
  reason: "scheduled" | "manual";
  force: boolean;
}

export interface TrendSummary {
  delta1h?: number;
  delta24h?: number;
  delta7d?: number;
  sparkline?: string;
  metricKey?: string;
  estimatedTimeToLimitSec?: number;
}

export interface MonitorState {
  snapshots: Map<string, ProviderSnapshot>;
  refreshing: Set<string>;
  paused: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorSnapshot(
  adapter: Pick<ProviderAdapter, "id" | "name" | "accountId" | "accountLabel">,
  source: ProviderSnapshot["source"],
  error: unknown,
): ProviderSnapshot {
  return {
    providerId: adapter.id,
    providerName: adapter.name,
    ...(adapter.accountId ? { accountId: adapter.accountId } : {}),
    ...(adapter.accountLabel ? { accountLabel: adapter.accountLabel } : {}),
    collectedAt: nowIso(),
    status: "error",
    source,
    summary: "Collection failed",
    windows: [],
    metrics: [],
    message: error instanceof Error ? error.message : String(error),
  };
}
