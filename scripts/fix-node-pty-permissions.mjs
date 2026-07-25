import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

try {
  const packagePath = require.resolve("node-pty/package.json");
  const helper = join(
    dirname(packagePath),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper) && process.platform !== "win32") {
    chmodSync(helper, 0o755);
  }
} catch (error) {
  const script = fileURLToPath(import.meta.url);
  process.stderr.write(`${script}: unable to prepare node-pty: ${String(error)}\n`);
  process.exitCode = 1;
}
