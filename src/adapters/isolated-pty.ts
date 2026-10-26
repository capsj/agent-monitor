import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { IPty, IPtyForkOptions } from "node-pty";

export type PtyRequest =
  | { type: "spawn"; executable: string; args: string[]; options: IPtyForkOptions }
  | { type: "write"; data: string }
  | { type: "kill"; signal?: string };
export type PtyResponse =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "error"; message: string };

/** Own each native PTY in a disposable process. node-pty 1.1.0 leaks native
 * descriptors on macOS, including when spawn throws before returning a handle.
 * Process exit reclaims those descriptors on both success and failure. */
export class IsolatedPty {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<() => void>();

  private constructor(private readonly child: ChildProcess) {}

  static async spawn(
    executable: string,
    args: string[],
    options: IPtyForkOptions,
    onData: (data: string) => void,
    onExit: () => void,
  ): Promise<IsolatedPty> {
    let worker = new URL("./pty-worker.js", import.meta.url);
    // Source-mode development and Vitest use tsx; installed builds use plain JS.
    const sourceMode = !existsSync(worker);
    if (sourceMode) worker = new URL("./pty-worker.ts", import.meta.url);
    const child = fork(worker, [], {
      execArgv: sourceMode ? ["--import", import.meta.resolve("tsx")] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const terminal = new IsolatedPty(child);
    terminal.onData(onData);
    terminal.onExit(onExit);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    await new Promise<void>((resolve, reject) => {
      let failure: string | undefined;
      let ready = false;
      child.on("message", (message: PtyResponse) => {
        if (message.type === "data") {
          for (const listener of terminal.dataListeners) listener(message.data);
        } else if (message.type === "ready") {
          ready = true;
          resolve();
        } else if (message.type === "error") {
          failure = message.message;
        }
      });
      child.once("error", reject);
      child.once("close", () => {
        for (const listener of terminal.exitListeners) listener();
        terminal.dataListeners.clear();
        terminal.exitListeners.clear();
        if (!ready) reject(new Error(failure ?? (stderr.trim() || "PTY helper exited before starting")));
      });
      child.send({ type: "spawn", executable, args, options } satisfies PtyRequest);
    });
    return terminal;
  }

  onData(listener: (data: string) => void): ReturnType<IPty["onData"]> {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }

  onExit(listener: () => void): ReturnType<IPty["onExit"]> {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }

  write(data: string): void {
    if (this.child.connected) this.child.send({ type: "write", data } satisfies PtyRequest);
  }

  kill(signal?: string): void {
    if (this.child.connected) this.child.send({ type: "kill", signal } satisfies PtyRequest);
  }
}
