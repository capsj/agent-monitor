import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderSnapshot, UsageWindow } from "../types.js";
import { nowIso } from "../types.js";
import { detectVersion } from "../utils/process.js";

export function parseGeminiQuota(raw: string, version?: string): ProviderSnapshot {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/[│┃╭╮╰╯─━┌┐└┘▬]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const windows = new Map<string, UsageWindow>();
  let inUsageSection = false;
  for (const line of lines) {
    if (/model usage|quota/i.test(line)) inUsageSection = true;
    const match = line.match(
      /^([A-Za-z][A-Za-z0-9 ._-]{0,30}?)\s+.*?(\d{1,3}(?:\.\d+)?)%\s*(?:used)?(?:\s+Resets?:\s*(.+))?$/i,
    );
    if (!match || !inUsageSection) continue;
    const label = match[1]?.trim();
    const usedPercent = Number(match[2]);
    if (!label || !Number.isFinite(usedPercent)) continue;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resetDescription = match[3]?.trim();
    windows.set(id, {
      id,
      label,
      usedPercent,
      ...(resetDescription ? { resetDescription } : {}),
      quality: "exact",
      category: "included",
    });
  }

  const joined = lines.join(" ");
  const pooled = joined.match(
    /(\d{1,3}(?:\.\d+)?)%\s+used(?:\s+\(Limit resets in\s+([^)]+)\))?/i,
  );
  if (pooled && windows.size === 0) {
    windows.set("pooled", {
      id: "pooled",
      label: "Pooled",
      usedPercent: Number(pooled[1]),
      ...(pooled[2] ? { resetDescription: pooled[2].trim() } : {}),
      quality: "exact",
      category: "included",
    });
  }
  const loginRequired = /sign in|authentication|not logged in/i.test(joined);
  const usageWindows = [...windows.values()];
  const primary = usageWindows[0];
  return {
    providerId: "gemini",
    providerName: "Gemini CLI",
    collectedAt: nowIso(),
    status: usageWindows.length > 0 ? "ok" : loginRequired ? "unavailable" : "partial",
    source: "cli",
    plan: joined.match(/\b(Free|Standard|Pro|Ultra|Enterprise)\b(?:\s+tier)?/i)?.[1] ?? null,
    summary:
      primary?.usedPercent !== undefined
        ? `${primary.usedPercent.toFixed(0)}% ${primary.label.toLowerCase()} used`
        : loginRequired
          ? "Not authenticated"
          : "Quota format not recognized",
    windows: usageWindows,
    metrics: [],
    message:
      usageWindows.length > 0
        ? null
        : loginRequired
          ? "Run gemini and sign in"
          : "Gemini's model quota display changed or returned no quota buckets",
    version: version ?? null,
  };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  readonly name = "Gemini CLI";
  readonly defaultRefreshMs: number;
  private version?: string;

  constructor(
    private readonly executable = "gemini",
    refreshMs = 60_000,
    private readonly sessionRoot = join(homedir(), ".gemini", "tmp"),
  ) {
    this.defaultRefreshMs = refreshMs;
  }

  async detect() {
    const result = await detectVersion(this.executable);
    this.version = result.version;
    return result;
  }

  async collect(): Promise<ProviderSnapshot> {
    if (!this.version) await this.detect();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const files = findSessionFiles(this.sessionRoot).filter((file) => {
      try {
        return statSync(file).mtimeMs >= startOfDay.getTime();
      } catch {
        return false;
      }
    });
    let total = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let thoughts = 0;
    for (const file of files) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(/"tokens"\s*:\s*\{([^}]+)\}/g)) {
        const tokenObject = match[1] ?? "";
        const read = (key: string): number => {
          const value = tokenObject.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`))?.[1];
          return value ? Number(value) : 0;
        };
        total += read("total");
        input += read("input");
        output += read("output");
        cached += read("cached");
        thoughts += read("thoughts");
      }
    }
    const metrics: ProviderSnapshot["metrics"] = [
      {
        key: "sessions",
        label: "Sessions",
        value: files.length,
        unit: "count",
        quality: "exact",
        period: "today",
        category: "local",
      },
      {
        key: "tokens",
        label: "Tokens",
        value: total,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      },
      {
        key: "input_tokens",
        label: "Input",
        value: input,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      },
      {
        key: "output_tokens",
        label: "Output",
        value: output,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      },
      {
        key: "cached_tokens",
        label: "Cached",
        value: cached,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      },
      {
        key: "thought_tokens",
        label: "Thoughts",
        value: thoughts,
        unit: "tokens",
        quality: "exact",
        period: "today",
        category: "local",
      },
    ];
    return {
      providerId: "gemini",
      providerName: "Gemini CLI",
      collectedAt: nowIso(),
      status: "partial",
      source: "local",
      plan: null,
      summary: `${total.toLocaleString()} tokens · ${files.length} sessions today`,
      windows: [],
      metrics,
      message:
        "Gemini exposes quota only after an API response in the active session; passive monitoring shows local activity without consuming quota",
      version: this.version ?? null,
    };
  }
}

function findSessionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("session-") &&
        entry.name.endsWith(".json")
      ) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}
