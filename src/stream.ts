import { createInterface } from "node:readline";
import { createAdapters } from "./adapters/index.js";
import { historyPath, type MonitorConfig } from "./config.js";
import { MonitorEngine } from "./core/engine.js";
import { HistoryStore } from "./core/history.js";
import {
  authenticateDashboard,
  dashboardAuthInstruction,
  dashboardProviderLabel,
  dashboardProviders,
  type DashboardAuthMode,
  type DashboardProvider,
} from "./dashboard-auth.js";
import { providerIds, type MonitorState, type ProviderId, type ProviderSnapshot } from "./types.js";

export interface MonitorStateMessage {
  type: "state";
  emittedAt: string;
  paused: boolean;
  refreshing: string[];
  snapshots: ProviderSnapshot[];
}

export interface AuthenticationMessage {
  type: "authentication";
  providerId: DashboardProvider;
  mode: DashboardAuthMode;
  status: "working" | "success" | "error" | "cancelled";
  message: string;
}

type StreamCommand =
  | { action: "refresh"; providerId?: ProviderId }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "togglePause" }
  | {
      action: "authenticateDashboard";
      providerId: DashboardProvider;
      mode: DashboardAuthMode;
    }
  | { action: "cancelAuthentication" }
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

export function parseStreamCommand(line: string): StreamCommand | undefined {
  try {
    const value = JSON.parse(line) as {
      action?: unknown;
      providerId?: unknown;
      mode?: unknown;
    };
    if (value.action === "refresh") {
      if (
        value.providerId !== undefined &&
        (typeof value.providerId !== "string" ||
          !providerIds.includes(value.providerId as ProviderId))
      ) {
        return undefined;
      }
      return {
        action: "refresh",
        ...(typeof value.providerId === "string"
          ? { providerId: value.providerId as ProviderId }
          : {}),
      };
    }
    if (
      value.action === "pause" ||
      value.action === "resume" ||
      value.action === "togglePause" ||
      value.action === "cancelAuthentication" ||
      value.action === "quit"
    ) {
      return { action: value.action };
    }
    if (
      value.action === "authenticateDashboard" &&
      typeof value.providerId === "string" &&
      dashboardProviders.includes(value.providerId as DashboardProvider) &&
      (value.mode === undefined || value.mode === "isolated" || value.mode === "personal")
    ) {
      return {
        action: "authenticateDashboard",
        providerId: value.providerId as DashboardProvider,
        mode: (value.mode ?? "isolated") as DashboardAuthMode,
      };
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
  let authenticationController: AbortController | undefined;
  let authenticationPromise: Promise<void> | undefined;
  const finish = (): void => {
    if (finishing) return;
    finishing = true;
    authenticationController?.abort();
    resolveDone?.();
  };

  const writeAuthentication = (message: AuthenticationMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const authenticate = (
    providerId: DashboardProvider,
    mode: DashboardAuthMode,
  ): void => {
    if (authenticationPromise) {
      writeAuthentication({
        type: "authentication",
        providerId,
        mode,
        status: "error",
        message: "Another dashboard connection is already in progress",
      });
      return;
    }
    const controller = new AbortController();
    authenticationController = controller;
    writeAuthentication({
      type: "authentication",
      providerId,
      mode,
      status: "working",
      message: dashboardAuthInstruction(providerId, mode),
    });
    authenticationPromise = (async () => {
      await engine.suspendProvider(providerId);
      try {
        await authenticateDashboard(providerId, mode, controller.signal);
        writeAuthentication({
          type: "authentication",
          providerId,
          mode,
          status: "success",
          message: `${dashboardProviderLabel(providerId)} connected. Usage is refreshing now.`,
        });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        writeAuthentication({
          type: "authentication",
          providerId,
          mode,
          status: cancelled ? "cancelled" : "error",
          message: cancelled
            ? "Dashboard connection cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        if (!finishing) engine.resumeProvider(providerId);
      }
    })().finally(() => {
      if (authenticationController === controller) authenticationController = undefined;
      authenticationPromise = undefined;
    });
  };

  input.on("line", (line) => {
    const command = parseStreamCommand(line);
    switch (command?.action) {
      case "refresh":
        if (command.providerId) {
          void engine.collect(command.providerId, true);
        } else {
          void engine.refreshAll();
        }
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
      case "authenticateDashboard":
        authenticate(command.providerId, command.mode);
        break;
      case "cancelAuthentication":
        authenticationController?.abort();
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
    authenticationController?.abort();
    await authenticationPromise?.catch(() => undefined);
    await engine.stop();
    history?.close();
  }
}
