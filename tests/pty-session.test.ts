import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PtySession } from "../src/adapters/pty-session.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("PTY session", () => {
  it("launches the child in its configured working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-monitor-pty-"));
    temporaryDirectories.push(cwd);
    const session = new PtySession(process.execPath, {
      args: [
        "-e",
        "process.stdout.write(process.cwd()); process.stdin.once('data', () => process.exit(0));",
      ],
      cwd,
      startupTimeoutMs: 2_000,
    });

    try {
      await session.start();
      expect(session.currentOutput()).toBe(realpathSync(cwd));
    } finally {
      await session.stop();
    }
  });
});
