# agent-monitor

A native macOS menu-bar monitor and `htop`-style terminal dashboard for keeping
an eye on your AI coding subscriptions and local agent usage in one place.

<p align="center">
  <img src="docs/images/agent-monitor-menubar.png" width="440" alt="Agent Monitor showing Codex, Claude Code, Cursor, OpenCode, and Gemini CLI usage in the macOS menu bar">
</p>

`agent-monitor` currently supports **Codex**, **Claude Code**, **Cursor**,
**OpenCode**, and **Gemini CLI**. It shows the information each provider
actually exposes—usage windows, reset times, credits, token counts, costs, and
local activity—without pretending that unlike metrics are directly
comparable. Claude Code can be monitored for several accounts at once.

![agent-monitor showing live Codex, Claude Code, Cursor, OpenCode, and Gemini CLI usage in the terminal](docs/images/agent-monitor-dashboard.png)

The exact fields depend on the provider, account, and CLI version.

> [!IMPORTANT]
> `agent-monitor` is a local, read-only monitor. It does not send prompts,
> transcripts, credentials, or usage data to its own server.

## How it works

Each provider exposes usage differently. `agent-monitor` uses a small adapter
for each one, collects only usage-related values, normalizes them into a common
snapshot format, and renders those snapshots with
[Ink](https://github.com/vadimdemedes/ink).

```text
Provider CLIs ───────┐
Local usage files ──┼─→ provider adapters ─→ snapshots ─┬─→ terminal UI
Provider usage APIs ┘                                   ├─→ macOS menu bar
                                                        └─→ local history
```

| Provider | Data source | What is available |
| --- | --- | --- |
| Codex | Local Codex app-server JSON-RPC | Account windows, reset times, credits, plan, and token history |
| Claude Code | Claude's usage API, using the sign-in Claude Code already saved | Session, weekly, and per-model limits with exact reset times; usage credits; plan |
| Cursor | Cursor's dashboard API, using the sign-in the Cursor app already saved | Included plan usage per model group, bonus usage, on-demand spending, billing cycle |
| OpenCode | `opencode stats`; Go usage API | Local activity, Go limits, estimated cost |
| Gemini CLI | Built-in `/stats`; local session metadata | Model quota when exposed, plus today's sessions and token totals |

No browser is involved. Every provider is polled on its own interval over
plain HTTPS or local commands, so nothing has to stay open for values to
update.

Collection runs independently for every provider. A provider failure therefore
affects only its own card. Successful values remain visible as stale data when
a later refresh fails, and repeated failures back off automatically.

Plan gauges consistently show the percentage of quota left, regardless of how
the provider reports usage. Green means ample quota remains; yellow and red
indicate that the configured usage thresholds have been reached. Additional or
overage gauges are explicitly labeled as used because they can exceed 100%.

By default, lightweight snapshots are stored in a local SQLite database so the
UI can calculate trends. Unchanged values are suppressed except for a
five-minute heartbeat, and data older than 90 days is removed automatically.
History can be disabled at any time.

## Quick start

### 1. Install the prerequisites

You will need:

- macOS
- Node.js 22.12 or newer
- [pnpm](https://pnpm.io/)
- At least one supported provider, already installed and signed in

You do not need every provider. Missing providers simply appear as
unavailable, and you can disable them in the configuration.

### 2. Install and build

From this repository:

```sh
pnpm install
pnpm build
pnpm link --global
```

If you only want to try it from the checkout, use `pnpm dev` instead of
linking it globally.

### 3. Check which providers are ready

```sh
agent-monitor doctor
```

This checks Node.js, the configured provider executables, and their detected
versions. For machine-readable output:

```sh
agent-monitor doctor --json
```

### 4. Start the monitor

```sh
agent-monitor
```

The monitor begins collecting immediately and refreshes each provider at its
own safe interval.

### 5. Install the macOS menu-bar app

The native app requires the macOS Command Line Tools and uses the same provider
engine as the terminal dashboard:

```sh
pnpm install:macos
```

This builds `Agent Monitor.app`, copies it to `/Applications`, and opens it.
From then on you can launch it from Spotlight, Launchpad, or Raycast, and the
**Launch at login** checkbox in its popover keeps it running after a restart.
The installed app runs the CLI from this checkout, so rebuild with
`pnpm install:macos` after pulling changes.

To build without installing, use `pnpm build:macos` and open
`build/Agent Monitor.app`.

The app has no Dock icon: click its gauge icon in the menu bar to see providers,
expand usage details, refresh one provider or all providers, or pause polling.

## Provider sign-ins

`agent-monitor` never asks you to sign in. It reuses the sign-ins that the
provider tools already keep on this Mac, read-only:

- **Claude Code** stores an OAuth token in the macOS keychain (or in
  `.credentials.json` inside its configuration directory). The monitor sends
  that token only to `api.anthropic.com` to read usage and plan details. Claude
  Code refreshes the token itself whenever it runs; if a token has expired, the
  monitor opens Claude Code once in a private workspace so it can refresh, and
  otherwise asks you to run `claude` for that account.
- **Cursor** keeps a dashboard session token in the Cursor app's local state
  database. The monitor opens that database read-only and sends the token only
  to `cursor.com`. Keep the Cursor app signed in.
- **OpenCode** keeps its Go API key in `auth.json`. The monitor sends it only to
  `opencode.ai`.
- **Codex** and **Gemini CLI** are read through their own local processes.

Set `reuseProviderCredentials` to `false` to turn all of this off; Claude,
Cursor, and OpenCode Go limits then show as unavailable.

## Keyboard controls

| Key | Action |
| --- | --- |
| `↑` / `↓` or `j` / `k` | Select a provider |
| `Enter` | Expand or collapse provider details |
| `r` | Refresh all providers now |
| `Space` | Pause or resume polling |
| `h` | Show help |
| `q` | Quit |

## Useful commands

```sh
# Start with selected providers only
agent-monitor --provider codex,opencode

# Use one refresh interval for this run
agent-monitor --refresh 30

# Run without writing history
agent-monitor --no-history

# Collect once and print JSON
agent-monitor snapshot

# Collect selected providers once
agent-monitor --provider codex,opencode snapshot

# Stream live state as JSON Lines (used by the native app)
agent-monitor stream

# Use a different configuration file
agent-monitor --config ./my-config.json
```

Global options such as `--provider`, `--refresh`, and `--config` must appear
before a subcommand.

When output is redirected or the process is run without an interactive TTY,
`agent-monitor` automatically emits a single JSON snapshot instead of opening
the terminal UI.

## Configuration

Configuration is optional. The default path is:

```text
~/.config/agent-monitor/config.json
```

Example:

```json
{
  "enabledProviders": ["codex", "claude", "cursor", "opencode", "gemini"],
  "refreshSeconds": {
    "codex": 30,
    "claude": 60,
    "cursor": 300,
    "opencode": 30,
    "gemini": 60
  },
  "executables": {
    "codex": "codex",
    "claude": "claude",
    "opencode": "opencode",
    "gemini": "gemini"
  },
  "accounts": {
    "claude": [
      { "id": "personal", "label": "Personal", "configDir": "~/.claude" },
      { "id": "work", "label": "Work", "configDir": "~/.claude-work" }
    ]
  },
  "warningPercent": 70,
  "criticalPercent": 90,
  "retentionDays": 90,
  "historyEnabled": true,
  "reuseProviderCredentials": true,
  "collectionTimeoutMs": 15000
}
```

Use `--config <path>` to load a different file. Executable values may also be
absolute paths when a provider CLI is not available through `PATH`.

### Several Claude Code accounts

Claude Code keeps one sign-in per configuration directory, selected with the
`CLAUDE_CONFIG_DIR` environment variable. List each directory under
`accounts.claude` and the monitor shows one card per account, labeled
`Claude Code · <label>`. With a single entry (the default, `~/.claude` or
`$CLAUDE_CONFIG_DIR`), the card is simply `Claude Code`.

## Local data and privacy

`agent-monitor` is designed to keep credentials and personal content out of its
own data:

- No API keys, OAuth tokens, session tokens, email addresses, prompts,
  transcripts, or raw terminal screens are written to configuration,
  history, logs, or snapshots.
- Codex credentials remain inside Codex; the monitor communicates with the
  already-authenticated local app-server.
- Claude Code and Cursor tokens are read into memory only for the duration of
  a request and sent only to their own provider's API.
- For OpenCode Go, the monitor reads only OpenCode's own `opencode-go` API-key
  record in memory and sends it only to `https://opencode.ai` for the read-only
  usage request.
- Gemini files are inspected only for session filenames and numeric `tokens`
  objects; message content is not retained.
- API parsing fails closed. An unknown response format produces partial or
  unavailable data instead of guessed values.

Local files on macOS are stored under:

```text
~/Library/Application Support/agent-monitor/
└── history.sqlite3
```

## Limitations

- The current release targets macOS.
- Provider CLIs and APIs can change without notice. Parsers surface
  unsupported formats as partial or unavailable.
- Codex's local app-server protocol is experimental.
- Cursor usage requires the Cursor desktop app to be installed and signed in;
  the `cursor-agent` CLI's own token is not accepted by Cursor's dashboard.
- OpenCode's billing balance is only shown on its web dashboard and is not
  collected.
- Gemini cannot report passive quota state until the Gemini CLI receives an API
  response; the monitor currently focuses on local activity.

## Development

```sh
pnpm dev        # run directly from TypeScript
pnpm typecheck  # check TypeScript
pnpm test       # run the test suite
pnpm build      # compile to dist/
pnpm check      # typecheck, test, and build
```

The automated test suite uses sanitized fixtures and temporary or in-memory
SQLite databases. It does not contact provider accounts.

## License

[MIT](LICENSE)
