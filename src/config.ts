import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { providerIds, type ProviderId } from "./types.js";

const executableSchema = z.object({
  codex: z.string().default("codex"),
  claude: z.string().default("claude"),
  cursor: z.string().default("cursor-agent"),
  opencode: z.string().default("opencode"),
  gemini: z.string().default("gemini"),
});

const intervalsSchema = z.object({
  codex: z.number().int().min(10).default(30),
  claude: z.number().int().min(30).default(60),
  cursor: z.number().int().min(30).default(300),
  opencode: z.number().int().min(10).default(30),
  gemini: z.number().int().min(30).default(60),
});

const configSchema = z.object({
  enabledProviders: z.array(z.enum(providerIds)).default([...providerIds]),
  refreshSeconds: intervalsSchema.default({
    codex: 30,
    claude: 60,
    cursor: 300,
    opencode: 30,
    gemini: 60,
  }),
  executables: executableSchema.default({
    codex: "codex",
    claude: "claude",
    cursor: "cursor-agent",
    opencode: "opencode",
    gemini: "gemini",
  }),
  warningPercent: z.number().min(0).max(100).default(70),
  criticalPercent: z.number().min(0).max(100).default(90),
  retentionDays: z.number().int().min(1).default(90),
  historyEnabled: z.boolean().default(true),
  reuseProviderCredentials: z.boolean().default(true),
  collectionTimeoutMs: z.number().int().min(1000).default(15_000),
});

export type MonitorConfig = z.infer<typeof configSchema>;

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-monitor", "config.json");
}

export function dataDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agent-monitor");
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "agent-monitor");
}

export function cacheDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "agent-monitor");
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "agent-monitor");
}

export function claudeWorkspacePath(): string {
  return join(cacheDirectory(), "claude-workspace");
}

export function geminiWorkspacePath(): string {
  return join(cacheDirectory(), "gemini-workspace");
}

export function opencodeAuthPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

export function historyPath(): string {
  return join(dataDirectory(), "history.sqlite3");
}

export function loadConfig(path = configPath()): MonitorConfig {
  let input: unknown = {};
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Unable to load ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const config = configSchema.parse(input);
  if (config.warningPercent >= config.criticalPercent) {
    throw new Error("warningPercent must be lower than criticalPercent");
  }
  return config;
}

export function providerRefreshMs(config: MonitorConfig, id: ProviderId): number {
  return config.refreshSeconds[id] * 1000;
}
