import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const credentialSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().optional(),
  }),
});

export interface ClaudeCredential {
  accessToken: string;
  expiresAt?: number;
}

/**
 * Claude Code stores one keychain item per configuration directory. The
 * default directory uses the bare service name; any other directory appends
 * the first eight hex characters of the SHA-256 of its absolute path.
 */
export function claudeKeychainService(configDir: string): string {
  const resolved = resolve(configDir);
  if (resolved === join(homedir(), ".claude")) return "Claude Code-credentials";
  const suffix = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

export function parseClaudeCredential(raw: string): ClaudeCredential | undefined {
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const { accessToken, expiresAt } = parsed.data.claudeAiOauth;
    return { accessToken, ...(expiresAt === undefined ? {} : { expiresAt }) };
  } catch {
    return undefined;
  }
}

export function claudeCredentialExpired(
  credential: ClaudeCredential,
  now = Date.now(),
  marginMs = 30_000,
): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt <= now + marginMs;
}

async function readKeychain(service: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 5_000, maxBuffer: 1_000_000, encoding: "utf8" },
    );
    return String(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readCredentialFile(configDir: string): string | undefined {
  try {
    return readFileSync(join(configDir, ".credentials.json"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read the OAuth access token Claude Code saved for a configuration directory.
 * The token stays in memory and is only ever sent to api.anthropic.com.
 */
export async function readClaudeCredential(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeCredential | undefined> {
  if (platform === "darwin") {
    const raw = await readKeychain(claudeKeychainService(configDir));
    const credential = raw ? parseClaudeCredential(raw) : undefined;
    if (credential) return credential;
  }
  const raw = readCredentialFile(resolve(configDir));
  return raw ? parseClaudeCredential(raw) : undefined;
}
