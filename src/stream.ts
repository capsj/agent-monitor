import { createInterface } from "node:readline";
import { createAdapters } from "./adapters/index.js";
import { historyPath, type MonitorConfig } from "./config.js";
import { MonitorEngine } from "./core/engine.js";
import { HistoryStore } from "./core/history.js";
import type { MonitorState, ProviderSnapshot } from "./types.js";

export interface MonitorStateMessage {
  type: "state";
  emittedAt: string;
  paused: boolean;
  refreshing: string[];
  snapshots: ProviderSnapshot[];
}

type StreamCommand =
  | { action: "refresh" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "togglePause" }
  | { action: "quit" };

export function monitorStateMessage(state: MonitorState): MonitorStateMessage {
  return {
    type: "state",
    emittedAt: new Date().toISOString(),
    paused: state.paused,
    refreshing: [...state.refreshing],
    snapshots: [...state.snapshots.values()],
  };
}

function parseCommand(line: string): StreamCommand | undefined {
  try {
    const value = JSON.parse(line) as { action?: unknown };
    if (
      value.action === "refresh" ||
      value.action === "pause" ||
      value.action === "resume" ||
      value.action === "togglePause" ||
      value.action === "quit"
    ) {
      return { action: value.action };
    }
  } catch {
    // Ignore malformed input so a GUI client cannot take down the monitor.
  }
  return undefined;
}

/**
 * Keep the monitor engine alive and expose state as newline-delimited JSON.
 * Commands are accepted on stdin, which gives native shells a tiny, stable IPC
 * surface without coupling them to the TypeScript implementation.
 */
export async function streamMonitor(config: MonitorConfig): Promise<void> {
  const history = config.historyEnabled
    ? new HistoryStore(historyPath(), config.retentionDays)
    : undefined;
  history?.prune();

  const engine = new MonitorEngine(createAdapters(config), config, history);
  const writeState = (state: MonitorState): void => {
    process.stdout.write(`${JSON.stringify(monitorStateMessage(state))}\n`);
  };
  const unsubscribe = engine.subscribe(writeState);
  const input = createInterface({ input: process.stdin, terminal: false });

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let finishing = false;
  const finish = (): void => {
    if (finishing) return;
    finishing = true;
    resolveDone?.();
  };

  input.on("line", (line) => {
    const command = parseCommand(line);
    switch (command?.action) {
      case "refresh":
        void engine.refreshAll();
        break;
      case "pause":
        engine.setPaused(true);
        break;
      case "resume":
        engine.setPaused(false);
        break;
      case "togglePause":
        engine.togglePaused();
        break;
      case "quit":
        finish();
        break;
    }
  });
  input.once("close", finish);
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);

  try {
    await engine.start();
    await done;
  } finally {
    input.close();
    unsubscribe();
    await engine.stop();
    history?.close();
  }
}
