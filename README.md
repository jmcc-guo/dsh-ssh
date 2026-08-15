# @jmcc-guo/dsh-ssh

[English](README.md) · [简体中文](README.zh.md)

![License: MIT](https://img.shields.io/github/license/jmcc-guo/dsh-ssh.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![Type](https://img.shields.io/badge/type-ESM-blueviolet.svg)

> AI-managed SSH connections with a live multi-tab terminal panel for DeepSeek Harness.

SSH terminal panel + AI connection manager for DeepSeek Harness (DSH).

The AI agent can autonomously create, address, and tear down SSH connections
right from the conversation (`ssh_connect` / `ssh_exec` / `ssh_list` /
`ssh_status` / `ssh_disconnect` / `ssh_exec_read` / `ssh_exec_kill` /
`ssh_delete`), while a XShell/Uniterm-style multi-tab terminal panel in the
Web GUI shows every command — model and human — in real time on the same
screen.

## Features

- **Model-driven connection lifecycle** — the agent connects by name or by
  parameters, runs commands with exit codes and readable failures, lists and
  inspects AI-managed connections, disconnects and deletes them. The same
  server may hold several independent connections (each with its own name,
  session state and command queue).
- **Auto-save & reuse** — every connection is persisted by name (unique
  across AI and user connections). After a DSH restart, `ssh_exec` on a saved
  name automatically re-establishes the connection from its saved settings.
- **Source model `ai` | `user`** — connections created by the AI are `ai`;
  connections created from the Settings page are `user`. The AI can never see
  or touch `user` connections (`ssh_list` hides them; `ssh_exec`/`ssh_status`/
  `ssh_disconnect`/`ssh_delete` reject them explicitly). A one-way
  **user → ai transfer** (with explicit confirmation, also offered under the
  tab bar for a user-created active tab) grants the AI access to a live
  connection without disconnecting it.
- **Keep-alive & reconnect** — idle keep-alive per connection; **automatic
  reconnect only for unexpected drops** (network blips, server resets) with
  exponential backoff (bounded attempts); **every explicit disconnect stays
  down** (tab close, `ssh_disconnect`, Settings "Disconnect" button). A
  "reconnected — the shell state was reset" notice is shown after an
  automatic reconnect.
- **Execution mutex (ai-source only)** — while an AI command runs on an `ai`
  connection, keystrokes are dropped server-side with a visible "AI is
  executing…" hint; a model `ssh_exec` against a connection whose shared
  terminal shell is still active waits until the shell falls quiet (no
  output/input for `shellQuietWaitMs`, default 2 s) or returns a readable
  "busy" result instead of interleaving output. `user` connections are never
  mutexed.
- **Tab semantics** — closing a tab disconnects immediately (no confirmation
  dialog); AI `ssh_disconnect` keeps the tab open showing "disconnected" (one
  click to reconnect); a model connect that has no tab re-opens one
  automatically. The tab bar's **"+"** opens saved connections — **each pick
  opens a fresh tab/session, even when that connection is already connected
  in another tab** — or starts a manual entry.
- **Live terminal column** — while the terminal panel is open it lives in
  DSH's native right details column (the conversation shrinks instead of
  being covered); closing it restores the original right column (tool
  details) untouched, and a slim SSH rail on the right edge reopens the
  panel. Each connection owns **one real interactive shell (PTY)**: the
  login banner (motd / Last login), the remote prompt `user@host:path$`,
  input echo and `cd` updates all come from the remote shell, exactly like a
  native SSH client. There is **no input box and no copy control** — click
  the terminal and type; keystrokes go straight into the remote shell
  (arrows, Tab, Ctrl-C, paste, IME supported). A blinking block cursor shows
  while the terminal is focused. AI-run commands appear in the same
  scrollback with source tags. Multi-tab, ANSI colors, scrollback.
- **Settings page** — "SSH Connections" under Settings manages everything:
  create, edit (rename supported), delete connections and their credentials
  (passwords / private keys stored in the DSH credential store), and
  connect/disconnect. The terminal column itself contains no CRUD.
- **Credential hygiene** — passwords and private keys live in the DSH
  credential store under generated references; the records file, logs and
  tool results never contain secret material; inline secrets in tool
  arguments are rejected with guidance; auth failures return scrubbed,
  readable reasons.
- **Settings** — the `dsh-ssh` settings namespace (heartbeat, reconnect
  policy, timeouts, output caps, records path) can be overridden through the
  DSH settings system / profile patch.
- **Bilingual UI** — Chinese and English copy.

## Requirements

- Node.js >= 18 (ESM)
- pnpm (lockfile: `pnpm-lock.yaml`)
- A DeepSeek Harness (DSH) installation with the `web` profile
- For the test suite: a reachable SSH server (the included tests target a
  local WSL OpenSSH instance; see `scripts/test-acceptance.mjs`)

## Install into a profile

```bash
# from npm (recommended)
dsh plugin --profile web add @jmcc-guo/dsh-ssh

# or directly from GitHub
dsh plugin --profile web add "github:jmcc-guo/dsh-ssh#v0.1.1"

# or from a local checkout
dsh plugin --profile web add <path-to-this-repo>
```

The bundle patch (`cordis.patch.yml`) mounts the `dsh-ssh` row. Override
config in the profile patch with the same row id:

```yaml
- id: dsh-ssh
  config:
    heartbeatIntervalMs: 20000
    reconnectMaxAttempts: 8
    outputLimitBytes: 2097152
```

Restart the profile process afterwards (plugin-set changes and the client
bundle graph are composed at boot).

## Settings namespace (`dsh-ssh`)

| Key | Default | Meaning |
| --- | --- | --- |
| `heartbeatIntervalMs` | 30000 | ssh2 keep-alive interval |
| `keepaliveCountMax` | 3 | keep-alive failures before the connection is considered dead |
| `connectTimeoutMs` | 15000 | SSH handshake / TCP connect timeout |
| `reconnectBaseDelayMs` | 2000 | first auto-reconnect delay (doubles per attempt) |
| `reconnectMaxDelayMs` | 60000 | backoff cap |
| `reconnectMaxAttempts` | 5 | max automatic reconnect attempts |
| `execTimeoutMs` | 120000 | default `ssh_exec` completion wait |
| `busyWaitTimeoutMs` | 20000 | default mutex wait when the connection is busy |
| `reconnectWaitTimeoutMs` | 30000 | default wait while reconnecting |
| `shellQuietWaitMs` | 2000 | shared-shell silence required before AI may run |
| `outputLimitBytes` | 1048576 | per-connection terminal buffer cap |
| `execOutputMaxBytes` | 200000 | cap on output returned to the model per command |
| `recordsPath` | `$DSH_HOME/storages/dsh-ssh/connections.json` | records file override |

## Model tools

- `ssh_connect` — create a new AI connection (host/port/user + auth by
  credential reference or key file path) or re-establish an existing one.
- `ssh_exec` — run a command on an AI connection by name; auto-reconnects
  when offline, waits through reconnect/busy states (with timeouts), returns
  output + exit code; long commands return an `execId` for
  `ssh_exec_read` / `ssh_exec_kill`.
- `ssh_exec_read` — incremental output of a running (or finished) command.
- `ssh_exec_kill` — terminate a running command (SIGINT through the pty).
- `ssh_list` — AI-visible connections with live status (never `user` ones).
- `ssh_status` — detailed status of one AI connection.
- `ssh_disconnect` — explicit disconnect (no auto-reconnect; optional
  `delete`); the panel tab stays open showing "disconnected".
- `ssh_delete` — delete a saved AI connection record (disconnects first).

**Secret rule for the model:** never pass passwords or private keys inline in
tool arguments (they are recorded verbatim in the session log and rejected).
Use `auth.passwordRef` / `auth.privateKeyRef` (a stored credential or
environment variable) or `auth.privateKeyPath` (a key file on the host).
New secrets can be stored through the panel's connection form, which routes
them into the DSH credential store.

## Security notes

- The panel channel (`/ssh/ws`) applies the harness browser-trust fence:
  loopback/trusted-host Host, same-origin Origin, cross-site fetch-metadata
  rejection.
- Secrets never leave the credential store: the records file holds
  references only; error messages are scrubbed; logs contain no secrets.
- Commands run through real PTYs on the remote host: ANSI output works,
  interactive programs work, and termination is a genuine SIGINT to the
  foreground process group. User keystrokes flow through the shared shell's
  PTY; while an AI command runs on an `ai`-source connection the host drops
  keystrokes (input mutex).

## Repository layout

```
lib/index.js            plugin entry: config schema, manager + tools + panel channel wiring
lib/manager.js          SshManager — connection lifecycle, keep-alive/reconnect, mutex, PTY shells
lib/tools.js            model tools (ssh_connect / ssh_exec / ssh_exec_read / ssh_exec_kill / ...)
lib/ws.js               panel WebSocket channel (/ssh/ws) with the browser-trust fence
lib/store.js            persisted connection records
lib/client.js           Web GUI client: multi-tab terminal panel + settings UI
cordis.patch.yml        bundle patch that mounts the dsh-ssh row
scripts/                test suites (see below)
```

## Development / tests

`scripts/` contains the acceptance suite and helpers (requires a reachable
SSH server; the included tests target a WSL OpenSSH instance):

```bash
node scripts/test-acceptance.mjs   # 65-check manager-level acceptance suite
node scripts/smoke.mjs             # quick smoke test
node scripts/test-panel-ws.mjs     # panel WebSocket channel drive (test web instance on :3081)
node scripts/test-rename.mjs       # focused rename test (no SSH server needed)
```

## Contributing

Issues and pull requests are welcome. Keep the model-facing surface (tool
names, parameter semantics, result shapes) backward compatible, and make sure
secrets never end up in logs, records or tool results.

## License

MIT
