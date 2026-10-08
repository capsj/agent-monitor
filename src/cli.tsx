#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import { createAdapters } from "./adapters/index.js";
import { collectSnapshot, runDoctor } from "./commands.js";
import {
  configPath,
  historyPath,
  loadConfig,
  type MonitorConfig,
} from "./config.js";
import { MonitorEngine } from "./core/engine.js";
import { HistoryStore } from "./core/history.js";
import { providerIds, type ProviderId } from "./types.js";
import { streamMonitor } from "./stream.js";
import { App } from "./ui/App.js";

interface GlobalOptions {
  config?: string;
  provider?: string;
  refresh?: string;
  history: boolean;
}

function configured(options: GlobalOptions): MonitorConfig {
  const config = loadConfig(options.config ?? configPath());
  const providers = options.provider
    ? options.provider.split(",").map((value) => value.trim()) as ProviderId[]
    : config.enabledProviders;
  for (const provider of providers) {
    if (!providerIds.includes(provider)) {
      throw new Error(`Unknown provider "${provider}". Expected: ${providerIds.join(", ")}`);
    }
  }
  const refresh = options.refresh ? Number(options.refresh) : undefined;
  if (refresh !== undefined && (!Number.isFinite(refresh) || refresh < 10)) {
    throw new Error("--refresh must be at least 10 seconds");
  }
  return {
    ...config,
    enabledProviders: providers,
    historyEnabled: options.history && config.historyEnabled,
    ...(refresh === undefined
      ? {}
      : {
          refreshSeconds: {
            codex: refresh,
            claude: Math.max(30, refresh),
            cursor: Math.max(30, refresh),
            opencode: refresh,
            gemini: Math.max(30, refresh),
          },
        }),
  };
}

async function interactive(options: GlobalOptions): Promise<void> {
  const config = configured(options);
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const snapshots = await collectSnapshot(config);
    process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
    return;
  }

  const history = config.historyEnabled
    ? new HistoryStore(historyPath(), config.retentionDays)
    : undefined;
  history?.prune();
  const engine = new MonitorEngine(createAdapters(config), config, history);
  const instance = render(<App engine={engine} config={config} history={history} />);
  void engine.start();

  const stop = (): void => instance.unmount();
  process.once("SIGTERM", stop);
  try {
    await instance.waitUntilExit();
  } finally {
    process.removeListener("SIGTERM", stop);
    await engine.stop();
    history?.close();
  }
}

const program = new Command()
  .name("agent-monitor")
  .description("Live usage monitor for AI coding subscriptions")
  .version("0.1.0")
  .option("-c, --config <path>", "configuration file")
  .option("-p, --provider <ids>", "comma-separated provider IDs")
  .option("-r, --refresh <seconds>", "override refresh interval")
  .option("--no-history", "disable SQLite history for this run");

program
  .command("snapshot")
  .description("collect one provider snapshot")
  .option("--json", "emit JSON", true)
  .action(async () => {
    const config = configured(program.opts<GlobalOptions>());
    const snapshots = await collectSnapshot(config);
    process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
  });

program
  .command("stream")
  .description("stream live monitor state as newline-delimited JSON")
  .action(async () => {
    const config = configured(program.opts<GlobalOptions>());
    await streamMonitor(config);
  });

program
  .command("doctor")
  .description("check executables and adapter readiness")
  .option("--json", "emit JSON")
  .action(async (options: { json?: boolean }) => {
    const config = configured(program.opts<GlobalOptions>());
    const report = await runDoctor(config);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    process.stdout.write(`agent-monitor doctor\n`);
    process.stdout.write(`Node ${report.node} · ${report.platform}\n`);
    for (const provider of report.providers) {
      const glyph = provider.available ? "✓" : "×";
      const name = provider.accountLabel
        ? `${provider.providerName} · ${provider.accountLabel}`
        : provider.providerName;
      process.stdout.write(
        `${glyph} ${name.padEnd(22)} ${provider.version ?? provider.message ?? "unknown"}\n`,
      );
    }
  });

program.action(async () => interactive(program.opts<GlobalOptions>()));

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`agent-monitor: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
