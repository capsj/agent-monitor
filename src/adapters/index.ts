import { expandHome, type MonitorConfig } from "../config.js";
import type { ProviderAdapter } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenCodeAdapter } from "./opencode.js";

export function createAdapters(config: MonitorConfig): ProviderAdapter[] {
  const claudeAccounts = config.accounts.claude;
  const all: ProviderAdapter[] = [
    new CodexAdapter(config.executables.codex, config.refreshSeconds.codex * 1000),
    ...claudeAccounts.map(
      (account) =>
        new ClaudeAdapter({
          executable: config.executables.claude,
          refreshMs: config.refreshSeconds.claude * 1000,
          timeoutMs: config.collectionTimeoutMs,
          account: {
            id: account.id,
            ...(account.label ? { label: account.label } : {}),
            ...(account.configDir ? { configDir: expandHome(account.configDir) } : {}),
          },
          multiAccount: claudeAccounts.length > 1,
          reuseProviderCredentials: config.reuseProviderCredentials,
        }),
    ),
    new CursorAdapter(
      config.refreshSeconds.cursor * 1000,
      config.collectionTimeoutMs,
      config.reuseProviderCredentials,
    ),
    new OpenCodeAdapter(
      config.executables.opencode,
      config.refreshSeconds.opencode * 1000,
      config.collectionTimeoutMs,
      config.reuseProviderCredentials,
    ),
    new GeminiAdapter(
      config.executables.gemini,
      config.refreshSeconds.gemini * 1000,
      config.collectionTimeoutMs,
    ),
  ];
  return all.filter((adapter) => config.enabledProviders.includes(adapter.id));
}
