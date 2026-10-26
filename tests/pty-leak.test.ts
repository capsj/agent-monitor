import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PtySession } from "../src/adapters/pty-session.js";

function descriptorCount(): number {
  return readdirSync("/dev/fd").length;
}

describe.skipIf(process.platform !== "darwin")("PTY descriptor lifecycle", () => {
  it("releases terminal handles after repeated successful sessions", async () => {
    const before = descriptorCount();
    for (let i = 0; i < 3; i++) {
      const session = new PtySession(process.execPath, {
        args: ["-e", "process.stdout.write('ready'); process.stdin.on('data', d => { const text = d.toString().trim(); if (text === '/exit') process.exit(0); else process.stdout.write('ack:' + text); });"],
        startupTimeoutMs: 2_000,
      });
      try {
        await session.start();
        expect(session.currentOutput()).toBe("ready");
        expect(await session.capture("ping", 2_000)).toContain("ack:ping");
      } finally {
        await session.stop();
      }
      expect(descriptorCount()).toBe(before);
    }
  }, 15_000);

  it("releases terminal handles when native spawn fails", async () => {
    const before = descriptorCount();
    for (let i = 0; i < 2; i++) {
      const session = new PtySession("/bin/echo", { args: ["x".repeat(3 * 1024 * 1024)] });
      try {
        await expect(session.start()).rejects.toThrow(/spawn/);
      } finally {
        await session.stop();
      }
      expect(descriptorCount()).toBe(before);
    }
  }, 10_000);
});
