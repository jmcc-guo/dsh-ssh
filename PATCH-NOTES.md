# Patch notes — DSH 0.2.0 desktop compatibility

**Status:** verified working
**Verified on:** 2026-09-30
**Verified with:** DSH `0.2.0-rc.2` · `@jmcc-guo/dsh-ssh@0.5.0` · **PC desktop client (Windows, Electron)**
**Tracking issue:** [jmcc-guo/dsh-ssh#1](https://github.com/jmcc-guo/dsh-ssh/issues/1)

If you are consuming this build (or a `pnpm` patched install of 0.5.0), this file
records what was changed, why, and on which combination it was verified, so that a
caller does not have to rediscover it.

---

## What was broken

The published `0.5.0` does not work on DSH `0.2.0-rc.2`, in two independent ways.

### 1. The plugin never activates (affects **every** client, browser included)

`lib/index.js` called `ctx.settings.register(name, Config, opts)`, which
DSH `0.2.0-rc.2` removed. `apply()` threw on its first statement, so **no tools were
registered and the `/ssh/ws` route was never mounted**:

```
dsh: warning: 1 entry did not activate
dsh-ssh (@jmcc-guo/dsh-ssh): TypeError: ctx.settings.register is not a function
    at Object.apply (…/lib/index.js:72:33)
```

The config for the row already arrives as `apply(ctx, config)`, so the manager now
takes that value directly. Live config reload (`settings.watch`) is kept only when a
legacy settings service still exposes `watch`; without one, a profile config change
applies on the next boot.

### 2. The panel channel could never open (affects the **desktop client only**)

Two causes:

- `lib/client.js` built the WebSocket URL from `window.location.host`. The desktop
  client serves the application document from its own privileged origin
  (`dsh-app://app/`), where that host is `app`, so the plugin dialled
  `ws://app/ssh/ws` — an address that can never resolve. The harness publishes the
  real Host origin for exactly this case as `__DSH_TRANSPORT__.streamBaseUrl` (the
  source built-in clients use); the plugin now prefers it and falls back to the
  document origin for a plain browser.
- `lib/ws.js` enforced `Origin.host === Host`, but the desktop shell's `Origin` is
  `dsh-app://app`, so the upgrade was rejected with `403`. The fence now also accepts
  that single origin — the harness's own shell, the same trust the loopback check
  already grants. Every other rejection is unchanged.

Symptoms a caller would otherwise see: a red link indicator, an empty saved-connection
list despite records existing on the Host, and every action failing with
`panel link not ready`.

---

## Files changed

| File | Change |
|---|---|
| `lib/index.js` | Drop the removed `ctx.settings.register` call; take the row config from `apply(ctx, config)` |
| `lib/ws.js` | Accept the desktop shell origin (`dsh-app://app`) after the same-host check |
| `lib/client.js` | Derive the WebSocket URL from `__DSH_TRANSPORT__.streamBaseUrl`, falling back to the document origin |

---

## Verification

Raw WebSocket upgrade handshakes against `/ssh/ws`, before and after (isolated
`DSH_HOME`, clean profile):

| Request | Before | After |
|---|---|---|
| `Origin: dsh-app://app` (desktop client) | `403 Forbidden` | **`101 Switching Protocols`** |
| `Origin: http://127.0.0.1:<port>` (browser, same-origin) | `101` | **`101`** |
| `Origin: http://evil.example` | `403` | **`403`** |
| `Origin: http://127.0.0.1:9999` (other port) | `403` | **`403`** |
| `Origin: dsh-app://evil` (forged scheme host) | `403` | **`403`** |
| Non-loopback `Host`, no `Origin` | `403` | **`403`** |

The fence loses no rejection; only the harness's own `dsh-app://app` shell origin is
additionally accepted, and a remote client cannot forge it.

With both defects fixed, an authenticated session completes end to end:

```
GET /ssh/ws  (Upgrade: websocket, Origin: dsh-app://app)
→ 101 Switching Protocols
→ {"id":1,"method":"snapshot","params":{}}
← {"event":"state","state":{"records":[],"tabs":[],"panelSurface":"auto"}}
```

`ssh_connect` and `ssh_exec` were then exercised against a real server from the same
machine, and the panel link indicator turned healthy in the desktop client.

---

## Notes for consumers

- Defect 1 is not desktop-specific: it breaks the plugin on any DSH `>= 0.2.0-rc.2`,
  browser included.
- Defect 2 is masked when the Web UI is served over plain HTTP in a browser, because
  `window.location.host` is then correct. **Testing only in a browser will not catch it.**
- If DSH would rather solve cause 2a centrally, proxying WebSocket upgrades to the Host
  in the desktop protocol handler would let any raw-WebSocket plugin work under
  `dsh-app://app/`.
