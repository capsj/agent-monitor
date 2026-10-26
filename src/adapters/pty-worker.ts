import * as pty from "node-pty";
import type { PtyRequest, PtyResponse } from "./isolated-pty.js";

let terminal: pty.IPty | undefined;
const send = (message: PtyResponse): void => {
  if (process.connected) process.send?.(message);
};

process.on("message", (message: PtyRequest) => {
  try {
    switch (message.type) {
      case "spawn":
        if (terminal) throw new Error("PTY helper already started");
        terminal = pty.spawn(message.executable, message.args, message.options);
        terminal.onData((data) => send({ type: "data", data }));
        terminal.onExit(() => {
          terminal = undefined;
          // Flush queued output before closing IPC and reclaiming native handles.
          process.disconnect();
        });
        send({ type: "ready" });
        break;
      case "write":
        terminal?.write(message.data);
        break;
      case "kill":
        terminal?.kill(message.signal);
        break;
    }
  } catch (error) {
    const message: PtyResponse = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    if (process.connected) process.send?.(message, () => process.exit(1));
    else process.exit(1);
  }
});

// Do not leave a provider running if the monitor disappears unexpectedly.
process.once("disconnect", () => {
  terminal?.kill("SIGKILL");
  process.exit(0);
});
