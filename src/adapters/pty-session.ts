import * as pty from "node-pty";
import { cleanTerminalOutput, resolveExecutable } from "../utils/process.js";

export interface PtySessionOptions {
  args?: string[];
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  startupSettleMs?: number;
  inputDelayMs?: number;
}

export class PtySession {
  private terminal?: pty.IPty;
  private buffer = "";
  private lastOutputAt = 0;
  private exited = false;

  constructor(
    private readonly executable: string,
    private readonly options: PtySessionOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.terminal && !this.exited) return;
    this.buffer = "";
    this.lastOutputAt = Date.now();
    this.exited = false;
    this.terminal = pty.spawn(resolveExecutable(this.executable), this.options.args ?? [], {
      name: "xterm-256color",
      cols: this.options.cols ?? 120,
      rows: this.options.rows ?? 40,
      cwd: this.options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        NO_COLOR: "1",
        ...this.options.env,
      } as Record<string, string>,
    });
    this.terminal.onData((chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 250_000) this.buffer = this.buffer.slice(-250_000);
      this.lastOutputAt = Date.now();
    });
    this.terminal.onExit(() => {
      this.exited = true;
    });
    await this.waitForSilence(700, this.options.startupTimeoutMs ?? 12_000, true);
    if (this.options.startupSettleMs) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.options.startupSettleMs),
      );
    }
  }

  currentOutput(): string {
    return cleanTerminalOutput(this.buffer);
  }

  async capture(command: string, timeoutMs = 10_000): Promise<string> {
    await this.start();
    if (!this.terminal || this.exited) throw new Error(`${this.executable} exited unexpectedly`);
    this.buffer = "";
    this.lastOutputAt = Date.now();
    this.terminal.write(command);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, this.options.inputDelayMs ?? 100),
    );
    this.terminal.write("\r");
    await this.waitForSilence(900, timeoutMs, true);
    return cleanTerminalOutput(this.buffer);
  }

  async stop(exitCommand = "/exit"): Promise<void> {
    const terminal = this.terminal;
    if (!terminal || this.exited) return;
    const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()));
    try {
      terminal.write(`${exitCommand}\r`);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } finally {
      if (!this.exited) {
        terminal.write("\x03");
        terminal.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      this.terminal = undefined;
      this.exited = true;
    }
  }

  private waitForSilence(
    silenceMs: number,
    timeoutMs: number,
    requireOutput = false,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const initialLength = this.buffer.length;
      const check = (): void => {
        if (this.exited) {
          reject(new Error(`${this.executable} exited before producing usage data`));
          return;
        }
        const now = Date.now();
        const sawOutput = this.buffer.length > initialLength;
        if (
          (!requireOutput || sawOutput) &&
          now - this.lastOutputAt >= silenceMs &&
          now - startedAt >= silenceMs
        ) {
          resolve();
          return;
        }
        if (now - startedAt >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });
  }
}
