import type { MonitorConfig } from "../config.js";
import type { ProviderAdapter } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenCodeAdapter } from "./opencode.js";

export function createAdapters(config: MonitorConfig): ProviderAdapter[] {
  const all: ProviderAdapter[] = [
    new CodexAdapter(config.executables.codex, config.refreshSeconds.codex * 1000),
    new ClaudeAdapter(
      config.executables.claude,
      config.refreshSeconds.claude * 1000,
      config.collectionTimeoutMs,
    ),
    new CursorAdapter(
      config.executables.cursor,
      config.refreshSeconds.cursor * 1000,
      config.collectionTimeoutMs,
    ),
    new OpenCodeAdapter(
      config.executables.opencode,
      config.refreshSeconds.opencode * 1000,
      config.collectionTimeoutMs,
    ),
    new GeminiAdapter(
      config.executables.gemini,
      config.refreshSeconds.gemini * 1000,
    ),
  ];
  return all.filter((adapter) => config.enabledProviders.includes(adapter.id));
}
