import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { dataDirectory } from "./config.js";

export const dashboardProviders = ["opencode", "claude", "cursor"] as const;
export type DashboardProvider = (typeof dashboardProviders)[number];
export type DashboardAuthMode = "isolated" | "personal";

interface DashboardDefinition {
  label: string;
  startUrl: string;
  instruction: string;
  dashboardUrl(url: URL): boolean;
}

interface DashboardMetadata {
  provider: DashboardProvider;
  url: string;
  authenticatedAt: string;
  mode?: DashboardAuthMode;
}

export type DashboardReadResult =
  | { status: "ok"; text: string; url: string }
  | { status: "not-configured"; message: string }
  | { status: "authentication-required"; message: string }
  | { status: "error"; message: string };

const definitions: Record<DashboardProvider, DashboardDefinition> = {
  opencode: {
    label: "OpenCode",
    startUrl: "https://opencode.ai/",
    instruction: "Sign in and open the workspace Go or Billing page. This window closes automatically when connected.",
    dashboardUrl: (url) =>
      (url.hostname === "opencode.ai" || url.hostname === "console.opencode.ai") &&
      /\/workspace\/[^/]+\/(?:go|billing)/.test(url.pathname),
  },
  claude: {
    label: "Claude",
    startUrl: "https://claude.ai/new#settings/usage",
    instruction: "Sign in and open Settings → Usage. This window closes automatically when connected.",
    dashboardUrl: (url) =>
      url.hostname === "claude.ai" &&
      (
        /\/settings\/(?:billing|usage)/.test(url.pathname) ||
        (url.pathname === "/new" && /^#settings\/(?:billing|usage)/.test(url.hash))
      ),
  },
  cursor: {
    label: "Cursor",
    startUrl: "https://cursor.com/dashboard",
    instruction: "Sign in and open the dashboard Usage page. This window closes automatically when connected.",
    dashboardUrl: (url) =>
      (url.hostname === "cursor.com" || url.hostname === "www.cursor.com") &&
      url.pathname.startsWith("/dashboard"),
  },
};

const execFileAsync = promisify(execFile);
let dashboardBrowserTail = Promise.resolve();

async function withExclusiveDashboardBrowser<T>(work: () => Promise<T>): Promise<T> {
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = dashboardBrowserTail;
  dashboardBrowserTail = previous.then(() => current);
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export function dashboardProviderLabel(provider: DashboardProvider): string {
  return definitions[provider].label;
}

export function dashboardAuthInstruction(
  provider: DashboardProvider,
  mode: DashboardAuthMode = "isolated",
): string {
  if (mode === "personal") {
    const navigation = definitions[provider].instruction.replace(
      /\s*This window closes automatically when connected\.$/,
      "",
    );
    return `${navigation} Keep that tab open for live updates.`;
  }
  return definitions[provider].instruction;
}

function profileRoot(provider: DashboardProvider): string {
  return join(dataDirectory(), "dashboard-profiles", provider);
}

function metadataPath(provider: DashboardProvider): string {
  return join(profileRoot(provider), "agent-monitor-dashboard.json");
}

function ensureProfile(provider: DashboardProvider): string {
  const root = profileRoot(provider);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function chromeExecutable(): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find(existsSync);
}

async function launchProfile(
  provider: DashboardProvider,
  headless: boolean,
): Promise<BrowserContext> {
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error(
      "Google Chrome or Chromium was not found; install one before using dashboard authentication",
    );
  }
  return chromium.launchPersistentContext(ensureProfile(provider), {
    executablePath,
    headless,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    args: ["--disable-background-networking"],
  });
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isDashboardUrl(provider: DashboardProvider, value: string): boolean {
  const url = parseUrl(value);
  return url ? definitions[provider].dashboardUrl(url) : false;
}

function saveMetadata(
  provider: DashboardProvider,
  url: string,
  mode: DashboardAuthMode,
): void {
  const path = metadataPath(provider);
  const metadata: DashboardMetadata = {
    provider,
    url,
    authenticatedAt: new Date().toISOString(),
    mode,
  };
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function readDashboardMetadata(
  provider: DashboardProvider,
): DashboardMetadata | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath(provider), "utf8")) as DashboardMetadata;
    if (
      parsed.provider !== provider ||
      typeof parsed.url !== "string" ||
      !isDashboardUrl(provider, parsed.url)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function dashboardAuthStatus(provider: DashboardProvider): {
  configured: boolean;
  url?: string;
  authenticatedAt?: string;
  mode?: DashboardAuthMode;
} {
  const metadata = readDashboardMetadata(provider);
  return metadata
    ? {
        configured: true,
        url: metadata.url,
        authenticatedAt: metadata.authenticatedAt,
        mode: metadata.mode ?? "isolated",
      }
    : { configured: false };
}

interface ChromeTab {
  windowIndex: number;
  tabIndex: number;
  url: string;
}

function personalChromeHelp(message: string): string {
  if (/javascript.*apple events|executing javascript.*turned off/i.test(message)) {
    return "In Chrome, enable View → Developer → Allow JavaScript from Apple Events, then retry personal-session authentication.";
  }
  if (/not authorized|automation|apple events/i.test(message)) {
    return "Allow agent-monitor or your terminal to control Google Chrome in System Settings → Privacy & Security → Automation.";
  }
  return message;
}

async function runAppleScript(source: string): Promise<string> {
  try {
    const result = await execFileAsync("/usr/bin/osascript", ["-e", source], {
      timeout: 10_000,
      maxBuffer: 300_000,
      encoding: "utf8",
    });
    return String(result.stdout);
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.message}${"stderr" in error ? ` ${(error as { stderr?: unknown }).stderr ?? ""}` : ""}`
        : String(error);
    throw new Error(personalChromeHelp(message.trim()));
  }
}

async function listPersonalChromeTabs(): Promise<ChromeTab[]> {
  const output = await runAppleScript(`
set outputText to ""
set fieldSeparator to ASCII character 9
tell application "Google Chrome"
  repeat with windowIndex from 1 to count of windows
    repeat with tabIndex from 1 to count of tabs of window windowIndex
      try
        set tabUrl to URL of tab tabIndex of window windowIndex
        set outputText to outputText & windowIndex & fieldSeparator & tabIndex & fieldSeparator & tabUrl & linefeed
      end try
    end repeat
  end repeat
end tell
return outputText
`);
  return output
    .split("\n")
    .map((line) => {
      const [windowIndex, tabIndex, ...urlParts] = line.trim().split("\t");
      return {
        windowIndex: Number(windowIndex),
        tabIndex: Number(tabIndex),
        url: urlParts.join("\t"),
      };
    })
    .filter(
      (tab) =>
        Number.isInteger(tab.windowIndex) &&
        Number.isInteger(tab.tabIndex) &&
        tab.url.length > 0,
    );
}

async function personalChromeTabText(tab: ChromeTab): Promise<string> {
  if (!Number.isInteger(tab.windowIndex) || !Number.isInteger(tab.tabIndex)) {
    throw new Error("Chrome tab selection became invalid");
  }
  const text = await runAppleScript(`
tell application "Google Chrome"
  execute tab ${tab.tabIndex} of window ${tab.windowIndex} javascript "document.body.innerText"
end tell
`);
  return text.slice(0, 250_000);
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function openPersonalChromeTab(provider: DashboardProvider): Promise<void> {
  const url = appleScriptString(definitions[provider].startUrl);
  await runAppleScript(`
tell application "Google Chrome"
  activate
  if (count of windows) is 0 then make new window
  set targetWindow to front window
  set createdTab to make new tab at end of tabs of targetWindow
  set URL of createdTab to ${url}
  set active tab index of targetWindow to count of tabs of targetWindow
end tell
`);
}

function loginScreen(text: string): boolean {
  return /\b(?:sign in|log in|continue with (?:google|email)|authentication required)\b/i.test(
    text,
  );
}

export function dashboardContentReady(provider: DashboardProvider, text: string): boolean {
  if (!text.trim()) return false;
  switch (provider) {
    case "claude":
      return /\b(?:plan usage limits?|current session|weekly limits?|usage credits?)\b/i.test(text);
    case "cursor":
      return /\b(?:current plan|included usage|cursor models|other models|on-demand)\b/i.test(text);
    case "opencode":
      return /\b(?:rolling usage|weekly usage|monthly usage|current balance)\b/i.test(text);
  }
}

async function readPersonalDashboard(
  provider: DashboardProvider,
  preferredUrl?: string,
): Promise<DashboardReadResult> {
  if (process.platform !== "darwin") {
    return {
      status: "error",
      message: "Personal Chrome collection currently requires macOS",
    };
  }
  try {
    const tabs = (await listPersonalChromeTabs()).filter((tab) =>
      isDashboardUrl(provider, tab.url),
    );
    const tab =
      tabs.find((candidate) => candidate.url === preferredUrl) ??
      tabs[0];
    if (!tab) {
      return {
        status: "error",
        message: `Keep the ${definitions[provider].label} usage page open in your personal Chrome session`,
      };
    }
    const text = await personalChromeTabText(tab);
    if (
      !text.trim() ||
      (loginScreen(text) && !/\b(?:usage|billing|balance|plan limits?)\b/i.test(text))
    ) {
      return {
        status: "authentication-required",
        message: `Sign in to ${definitions[provider].label} in the open personal Chrome tab`,
      };
    }
    return { status: "ok", text, url: tab.url };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function authenticatePersonalDashboard(
  provider: DashboardProvider,
  signal?: AbortSignal,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Personal Chrome authentication currently requires macOS");
  }
  await openPersonalChromeTab(provider);
  const deadline = Date.now() + 5 * 60_000;
  let lastMessage = dashboardAuthInstruction(provider, "personal");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Dashboard authentication cancelled");
    const result = await readPersonalDashboard(provider);
    if (result.status === "ok") {
      saveMetadata(provider, result.url, "personal");
      return result.url;
    }
    lastMessage = result.message;
    if (
      result.status === "error" &&
      /Allow JavaScript from Apple Events|Privacy & Security → Automation/.test(result.message)
    ) {
      throw new Error(result.message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Personal Chrome authentication timed out. ${lastMessage}`);
}

async function authenticateDashboardUnlocked(
  provider: DashboardProvider,
  mode: DashboardAuthMode = "isolated",
  signal?: AbortSignal,
): Promise<string> {
  if (mode === "personal") return authenticatePersonalDashboard(provider, signal);
  if (signal?.aborted) throw new Error("Dashboard authentication cancelled");
  const definition = definitions[provider];
  const context = await launchProfile(provider, false);
  const abort = (): void => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  let selectedUrl: string | undefined;
  let contextClosed = false;
  context.once("close", () => {
    contextClosed = true;
  });

  const observe = (page: Page): void => {
    const remember = (): void => {
      if (isDashboardUrl(provider, page.url())) selectedUrl = page.url();
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) remember();
    });
    remember();
  };
  context.on("page", observe);
  for (const page of context.pages()) observe(page);

  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(definition.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    await context.close().catch(() => undefined);
    throw error;
  }
  if (isDashboardUrl(provider, page.url())) selectedUrl = page.url();

  const deadline = Date.now() + 5 * 60_000;
  try {
    while (!contextClosed && Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Dashboard authentication cancelled");
      for (const openPage of context.pages()) {
        if (!isDashboardUrl(provider, openPage.url())) continue;
        selectedUrl = openPage.url();
        const text = await openPage
          .locator("body")
          .innerText({ timeout: 1_500 })
          .catch(() => "");
        if (!dashboardContentReady(provider, text)) continue;
        saveMetadata(provider, selectedUrl, "isolated");
        await context.close().catch(() => undefined);
        return selectedUrl;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (signal?.aborted) throw new Error("Dashboard authentication cancelled");
  await context.close().catch(() => undefined);
  throw new Error(
    selectedUrl
      ? `${definition.label} opened, but its usage data was not available. Finish signing in and try again.`
      : `No ${definition.label} usage page was detected. Sign in and open its usage or billing page.`,
  );
}

export function authenticateDashboard(
  provider: DashboardProvider,
  mode: DashboardAuthMode = "isolated",
  signal?: AbortSignal,
): Promise<string> {
  return withExclusiveDashboardBrowser(() =>
    authenticateDashboardUnlocked(provider, mode, signal),
  );
}

export class DashboardSession {
  private context?: BrowserContext;
  private page?: Page;
  private cached?: { at: number; result: DashboardReadResult };

  constructor(
    readonly provider: DashboardProvider,
    private readonly timeoutMs = 20_000,
    private readonly cacheMs = 60_000,
  ) {}

  async read(force = false): Promise<DashboardReadResult> {
    if (force) this.cached = undefined;
    if (!force && this.cached && Date.now() - this.cached.at < this.cacheMs) {
      return this.cached.result;
    }
    const metadata = readDashboardMetadata(this.provider);
    if (!metadata) {
      return {
        status: "not-configured",
        message: `Connect the ${definitions[this.provider].label} dashboard to add usage data`,
      };
    }
    if ((metadata.mode ?? "isolated") === "personal") {
      const result = await withExclusiveDashboardBrowser(() =>
        readPersonalDashboard(this.provider, metadata.url),
      );
      this.cached = { at: Date.now(), result };
      return result;
    }

    return withExclusiveDashboardBrowser(async () => {
      try {
        this.context = await launchProfile(this.provider, true);
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
        const targetUrl =
          this.provider === "claude"
            ? definitions.claude.startUrl
            : metadata.url;
        await this.page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
        await this.page
          .waitForLoadState("networkidle", { timeout: Math.min(this.timeoutMs, 5_000) })
          .catch(() => undefined);
        if (!isDashboardUrl(this.provider, this.page.url())) {
          return {
            status: "authentication-required",
            message: `Dashboard session expired; run agent-monitor auth ${this.provider}`,
          };
        }
        const text = (
          await this.page.locator("body").innerText({ timeout: this.timeoutMs })
        ).slice(0, 250_000);
        if (/\b(?:sign|log)\s*in\b/i.test(text) && !/usage|billing|balance/i.test(text)) {
          return {
            status: "authentication-required",
            message: `Dashboard session expired; run agent-monitor auth ${this.provider}`,
          };
        }
        const result: DashboardReadResult = { status: "ok", text, url: this.page.url() };
        this.cached = { at: Date.now(), result };
        return result;
      } catch (error) {
        return {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await this.context?.close().catch(() => undefined);
        this.context = undefined;
        this.page = undefined;
      }
    });
  }

  async stop(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
    this.cached = undefined;
  }
}
