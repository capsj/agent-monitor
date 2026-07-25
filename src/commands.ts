import type { MonitorConfig } from "./config.js";
import { createAdapters } from "./adapters/index.js";
import { errorSnapshot, type ProviderSnapshot } from "./types.js";

export async function collectSnapshot(config: MonitorConfig): Promise<ProviderSnapshot[]> {
  const adapters = createAdapters(config);
  return Promise.all(
    adapters.map(async (adapter) => {
      try {
        await adapter.start?.();
        return await adapter.collect();
      } catch (error) {
        return errorSnapshot(
          adapter.id,
          adapter.name,
          adapter.id === "codex" ? "structured" : adapter.id === "opencode" ? "local" : "cli",
          error,
        );
      } finally {
        await adapter.stop?.().catch(() => undefined);
      }
    }),
  );
}

export async function runDoctor(config: MonitorConfig) {
  const adapters = createAdapters(config);
  const results = await Promise.all(
    adapters.map(async (adapter) => ({
      providerId: adapter.id,
      providerName: adapter.name,
      refreshSeconds: adapter.defaultRefreshMs / 1000,
      ...(await adapter.detect()),
    })),
  );
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    historyEnabled: config.historyEnabled,
    providers: results,
  };
}
