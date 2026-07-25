import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import stripAnsi from "strip-ansi";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function cleanTerminalOutput(value: string): string {
  return stripAnsi(value)
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveExecutable(executable: string): string {
  if (executable.includes("/")) return executable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return executable;
}

export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, options.timeoutMs ?? 10_000);
    timer.unref();

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

export async function detectVersion(
  executable: string,
  args: string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<{ available: boolean; version?: string; message?: string }> {
  try {
    const result = await runCommand(executable, args, { timeoutMs });
    if (result.timedOut) {
      return { available: false, message: "Version check timed out" };
    }
    const output = cleanTerminalOutput(result.stdout || result.stderr);
    return {
      available: result.exitCode === 0,
      ...(output ? { version: output.split("\n")[0] } : {}),
      ...(result.exitCode === 0 ? {} : { message: output || `Exited with ${result.exitCode}` }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      available: false,
      message: code === "ENOENT" ? "Executable not found" : String(error),
    };
  }
}
