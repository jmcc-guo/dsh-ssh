/**
 * @jmcc-guo/dsh-ssh — SSH connection manager.
 *
 * Owns connection records, live sessions, keep-alive, automatic reconnect for
 * unexpected drops only, per-connection execution mutex (ai-source only),
 * terminal entry streams, the panel tab registry, and every model-facing and
 * panel-facing operation. The class is Cordis-free: it receives a thin deps
 * object ({credentials, logger}) so it can be driven directly by acceptance
 * tests as well as by the plugin entry (`index.js`).
 *
 * Each connected session holds ONE persistent interactive shell (a real pty
 * channel) — the terminal renders its banner/motd, its prompt and its echo,
 * exactly like a live SSH client. The user's keystrokes are written straight
 * into that shell. AI commands run on separate exec channels; they wait for
 * the shared shell to fall quiet (no output/input for shellQuietWaitMs) and
 * user keystrokes are dropped while an AI command runs on an ai-source
 * connection (input mutex).
 * @module @jmcc-guo/dsh-ssh/manager
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';
import { ConnectionRecord, RecordStore, credentialRefFor, defaultRecordsPath } from './store.js';

/** Terminal entry kinds. */
export const ENTRY_START = 'start';
export const ENTRY_OUT = 'out';
export const ENTRY_END = 'end';
export const ENTRY_NOTICE = 'notice';

/** Session statuses. */
export const STATUS_CONNECTING = 'connecting';
export const STATUS_CONNECTED = 'connected';
export const STATUS_RECONNECTING = 'reconnecting';
export const STATUS_DISCONNECTED = 'disconnected';
export const STATUS_ERROR = 'error';

/** Default config values (overridable through the dsh-ssh settings namespace). */
export const DEFAULT_CONFIG = Object.freeze({
  heartbeatIntervalMs: 30000,
  keepaliveCountMax: 3,
  connectTimeoutMs: 15000,
  reconnectBaseDelayMs: 2000,
  reconnectMaxDelayMs: 60000,
  reconnectMaxAttempts: 5,
  execTimeoutMs: 120000,
  busyWaitTimeoutMs: 20000,
  reconnectWaitTimeoutMs: 30000,
  /** The shared terminal shell must stay silent this long before AI may run. */
  shellQuietWaitMs: 2000,
  outputLimitBytes: 1048576,
  execOutputMaxBytes: 200000,
  recordsPath: '',
});

function clampConfig(input) {
  const c = input ?? {};
  const out = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = c[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    else if (typeof value === 'string' && key === 'recordsPath') out[key] = value;
  }
  return out;
}

/** Allocate a short unique id. */
function uid() {
  return randomBytes(5).toString('hex');
}

/** Sanitize an ssh2/Node error into a readable, secret-free message. */
function readableError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) message = message.split(secret).join('[REDACTED]');
  }
  return message;
}

/** Async sleep honoring an AbortSignal. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One live SSH session for a connection record.
 *
 * A record's PRIMARY session uses the record name as its key and is the
 * session the model tools address by name. The panel may open additional
 * independent sessions for the same record ("+" on an already-connected
 * connection): those get unique keys and never collide with the primary.
 */
class Session {
  constructor(manager, record, key) {
    this.manager = manager;
    this.record = record;
    this.key = key;
    this.status = STATUS_DISCONNECTED;
    this.client = null;
    this.explicitClose = false;
    this.lastError = null;
    this.connectedAt = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.connectPromise = null;
    this.connectTimer = null;
    this.wasReconnecting = false;
    /** Map<execId, Cmd> — active commands on this connection. */
    this.activeCommands = new Map();
    /** Terminal stream. */
    this.entries = [];
    this.entryBytes = 0;
    this.seq = 0;
    /** The persistent interactive shell channel (real pty) of this session. */
    this.shellStream = null;
    /** Last moment the shared shell produced output or received input (ms). */
    this.shellLastActivity = 0;
    /** Ptyw size of the shared shell. */
    this.shellRows = 40;
    this.shellCols = 160;
    /** Pending quiet-gated pty resize timer (null when none pending). */
    this.resizeTimer = null;
  }

  /** Public status snapshot for wire/UI. */
  statusPublic() {
    return {
      key: this.key,
      name: this.record.name,
      source: this.record.source,
      host: this.record.host,
      port: this.record.port,
      user: this.record.user,
      tunnel: this.record.tunnel,
      authType: this.record.auth.type,
      status: this.status,
      busyBy: this.busyKind(),
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.status === STATUS_RECONNECTING ? this.reconnectAttempts : 0,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
    };
  }

  /** Kind of the oldest active command, or null. */
  busyKind() {
    for (const cmd of this.activeCommands.values()) return cmd.kind;
    return null;
  }

  /** Append one terminal entry, honoring the byte cap. */
  appendEntry(kind, text, extra = {}) {
    const entry = {
      seq: ++this.seq,
      ts: Date.now(),
      kind,
      text,
      source: extra.source ?? null,
      exitCode: extra.exitCode ?? null,
      execId: extra.execId ?? null,
    };
    this.entries.push(entry);
    this.entryBytes += String(text).length + 64;
    const cap = this.manager.config.outputLimitBytes;
    while (this.entries.length > 0 && this.entryBytes > cap) {
      const dropped = this.entries.shift();
      this.entryBytes -= String(dropped.text).length + 64;
    }
    this.manager.emitTerminal(this.record.name, [entry]);
    return entry;
  }

  clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  isExplicit() {
    return this.explicitClose;
  }
}

/**
 * One running command on a session.
 */
class Cmd {
  constructor(session, kind, command) {
    this.session = session;
    this.kind = kind; // 'ai' | 'user'
    this.command = String(command);
    this.execId = uid();
    /** The ssh2 client this command runs on (for stale-close filtering). */
    this.client = null;
    this.stream = null;
    this.stdoutParts = [];
    this.stderrParts = [];
    this.bytes = 0;
    this.done = false;
    this.killed = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.error = null;
    this.startedAt = Date.now();
    this.endedAt = null;
  }

  /** Collected output so far, capped to maxBytes. */
  output(maxBytes) {
    const raw = [...this.stdoutParts, ...this.stderrParts].join('');
    if (raw.length <= maxBytes) return { text: raw, truncated: false };
    return { text: raw.slice(-maxBytes), truncated: true };
  }

  push(part, isStderr) {
    const text = String(part);
    (isStderr ? this.stderrParts : this.stdoutParts).push(text);
    this.bytes += text.length;
  }

  finish({ exitCode = null, signal = null, killed = false, error = null } = {}) {
    if (this.done) return;
    this.done = true;
    this.endedAt = Date.now();
    this.exitCode = exitCode;
    this.exitSignal = signal;
    this.killed = killed;
    this.error = error;
    this.session.activeCommands.delete(this.execId);
    // Keep finished commands readable through the registry (capped).
    this.session.manager.execRegistry.set(this.execId, this);
    this.session.manager.pruneExecRegistry();
  }

  /** Terminate the remote process: SIGINT through the pty, then channel close. */
  kill() {
    if (this.done) return false;
    const stream = this.stream;
    if (stream && !stream.destroyed) {
      try {
        stream.write('\x03'); // SIGINT to the foreground process group
      } catch { /* stream already closing */ }
      setTimeout(() => {
        try {
          if (!this.done && stream && !stream.destroyed) stream.close();
        } catch { /* ignore */ }
      }, 1000);
    }
    this.killed = true;
    return true;
  }
}

/**
 * SSH connection manager (see module doc).
 */
export class SshManager {
  /**
   * @param deps - {credentials, logger}.
   * @param config - resolved plugin config (partial ok).
   * @param homeDir - DSH home override (tests).
   */
  constructor(deps, config = {}, homeDir) {
    this.deps = deps;
    this.config = clampConfig(config);
    this.store = new RecordStore(this.config.recordsPath || defaultRecordsPath(homeDir), deps.logger);
    /** Map<name, Session> */
    this.sessions = new Map();
    /** Map<execId, Cmd> across all sessions. */
    this.execRegistry = new Map();
    /** Panel tab registry: names in open order. */
    this.tabs = [];
    /** WS clients. */
    this.clients = new Set();
    /** Tunnel clients: Map<tunnel record name, {client, sessions:Set<key>}>. */
    this.tunnelClients = new Map();
    /** In-flight tunnel client connections: Map<name, Promise>. */
    this.tunnelPending = new Map();
    this.disposed = false;
  }

  // ------------------------------------------------------------------ setup

  /** Load records from disk. */
  initialize() {
    this.store.load();
  }

  /** Apply a new config (settings change). */
  reconfigure(config) {
    this.config = clampConfig(config);
  }

  /** Close every session and stop every timer. */
  async shutdown() {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.clearReconnect();
      if (session.connectTimer !== null) clearTimeout(session.connectTimer);
      session.explicitClose = true;
      for (const cmd of session.activeCommands.values()) cmd.finish({ killed: true });
      this.closeShell(session);
      const client = session.client;
      session.client = null;
      if (client) {
        try {
          client.end();
        } catch { /* ignore */ }
      }
      if (session.record.tunnel) await this.releaseTunnelChain(session.record, session.key);
    }
    // Safety net: close any tunnel client the per-session release missed.
    for (const entry of this.tunnelClients.values()) {
      try {
        entry.client.end();
      } catch { /* ignore */ }
    }
    this.tunnelClients.clear();
    this.sessions.clear();
    this.clients.clear();
  }

  // ---------------------------------------------------------------- events

  /** Attach a WS client; it receives a state snapshot on attach. */
  attachClient(client) {
    this.clients.add(client);
    this.send(client, { event: 'state', state: this.stateSnapshot() });
    return () => this.detachClient(client);
  }

  detachClient(client) {
    this.clients.delete(client);
  }

  send(client, payload) {
    try {
      if (client.readyState === 1) client.send(JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  emitTerminal(name, entries) {
    const payload = { event: 'terminal', name, entries };
    for (const client of this.clients) this.send(client, payload);
  }

  emitState() {
    const payload = { event: 'state', state: this.stateSnapshot() };
    for (const client of this.clients) this.send(client, payload);
  }

  /** Full panel state snapshot. */
  stateSnapshot() {
    return {
      records: this.sessionsPublic(),
      tabs: this.tabs
        .map((key) => {
          const session = this.sessions.get(key);
          return session !== undefined ? session.statusPublic() : null;
        })
        .filter((tab) => tab !== null),
    };
  }

  /**
   * Public records list — ONE entry per saved record (panel settings page,
   * "+" dialog, tools). The status reflects the record's PRIMARY session.
   */
  sessionsPublic() {
    return this.store.list().map((record) => {
      const session = this.sessions.get(record.name);
      return session !== undefined ? session.statusPublic() : {
        key: record.name,
        name: record.name,
        source: record.source,
        host: record.host,
        port: record.port,
        user: record.user,
        tunnel: record.tunnel,
        authType: record.auth.type,
        status: STATUS_DISCONNECTED,
        busyBy: null,
        lastError: null,
        connectedAt: null,
        reconnectAttempts: 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  }

  /** AI-visible public status list (tools/tests). */
  aiListPublic() {
    return this.sessionsPublic().filter((item) => item.source === 'ai');
  }

  /** Public status of one connection (tests/helpers) — the primary session. */
  statusOf(name) {
    const record = this.store.get(name);
    if (!record) return undefined;
    const session = this.sessions.get(name);
    return session !== undefined ? session.statusPublic() : {
      key: name,
      name: record.name,
      source: record.source,
      host: record.host,
      port: record.port,
      user: record.user,
      tunnel: record.tunnel,
      authType: record.auth.type,
      status: STATUS_DISCONNECTED,
      busyBy: null,
      lastError: null,
      connectedAt: null,
      reconnectAttempts: 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** Public status of one SESSION by key (panel tabs). */
  tabPublic(key) {
    const session = this.sessions.get(key);
    return session !== undefined ? session.statusPublic() : null;
  }

  // ------------------------------------------------------------------ auth

  /** Resolve the secret material for a record. Returns {ok, error?, secrets?, connectOpts?}. */
  async resolveAuth(record) {
    const secrets = [];
    const auth = record.auth;
    if (auth.type === 'password') {
      const ref = auth.passwordRef;
      if (!ref) return { ok: false, error: 'password auth selected but no password credential is configured' };
      const resolved = await this.deps.credentials.resolve(ref);
      if (!resolved || !resolved.value) {
        return { ok: false, error: `password credential "${ref}" is not configured (store it via the SSH panel connection form or as an environment variable)` };
      }
      secrets.push(resolved.value);
      return { ok: true, secrets, connectOpts: { password: resolved.value } };
    }
    let keyMaterial;
    if (auth.keyPath) {
      try {
        keyMaterial = readFileSync(auth.keyPath, 'utf8');
      } catch (error) {
        return { ok: false, error: `cannot read private key file "${auth.keyPath}": ${readableError(error)}` };
      }
    } else if (auth.privateKeyRef) {
      const resolved = await this.deps.credentials.resolve(auth.privateKeyRef);
      if (!resolved || !resolved.value) {
        return { ok: false, error: `private key credential "${auth.privateKeyRef}" is not configured` };
      }
      keyMaterial = resolved.value;
      secrets.push(resolved.value);
    } else {
      return { ok: false, error: 'privateKey auth selected but neither keyPath nor privateKeyRef is configured' };
    }
    let passphrase;
    if (auth.passphraseRef) {
      const resolved = await this.deps.credentials.resolve(auth.passphraseRef);
      if (resolved && resolved.value) {
        passphrase = resolved.value;
        secrets.push(resolved.value);
      }
    }
    return { ok: true, secrets, connectOpts: { privateKey: keyMaterial, ...(passphrase !== undefined ? { passphrase } : {}) } };
  }

  // ------------------------------------------------------------- record CRUD

  /**
   * Create a connection record. Names are globally unique across sources.
   * @param input - {name, host, port?, user, auth, source}.
   * @returns {ok:true, record} or {ok:false, error}.
   */
  async createRecord(input) {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'connection name is required' };
    if (this.store.has(name)) {
      return { ok: false, error: `connection name "${name}" is already taken by another connection / 连接名 "${name}" 已被其他连接占用` };
    }
    const host = String(input.host ?? '').trim();
    if (!host) return { ok: false, error: 'host is required' };
    const user = String(input.user ?? '').trim();
    if (!user) return { ok: false, error: 'user is required' };
    const tunnel = normalizeTunnelInput(this.store, name, input.tunnel);
    if (!tunnel.ok) return tunnel;
    const port = Number(input.port ?? 22);
    const auth = normalizeAuthInput(input.auth);
    if (!auth) return { ok: false, error: 'auth is required: password credential ref or private key path/ref (secrets must not be passed inline)' };
    const record = new ConnectionRecord({
      name,
      source: input.source === 'user' ? 'user' : 'ai',
      host,
      port,
      user,
      tunnel: tunnel.value,
      auth,
    });
    await this.store.put(record);
    this.emitState();
    return { ok: true, record };
  }

  /**
   * Panel creation: store secrets through the credential service under
   * references derived from the new record, then create + connect.
   * @param input - {name, host, port?, user, source, password?, privateKey?, passphrase?}.
   */
  async createRecordWithSecrets(input) {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'connection name is required' };
    if (this.store.has(name)) {
      return { ok: false, error: `connection name "${name}" is already taken by another connection / 连接名 "${name}" 已被其他连接占用` };
    }
    const host = String(input.host ?? '').trim();
    if (!host) return { ok: false, error: 'host is required' };
    const user = String(input.user ?? '').trim();
    if (!user) return { ok: false, error: 'user is required' };
    const tunnel = normalizeTunnelInput(this.store, name, input.tunnel);
    if (!tunnel.ok) return tunnel;
    const port = Number(input.port ?? 22);
    // Allocate the record first so the credential references derive from its id.
    // Panel-created records are always user-source (spec); source is forced.
    const record = new ConnectionRecord({
      name,
      source: 'user',
      host,
      port,
      user,
      tunnel: tunnel.value,
      auth: { type: 'password' },
    });
    const stored = await this.storeSecrets(record, input);
    if (!stored.ok) return stored;
    record.auth = stored.auth;
    await this.store.put(record);
    this.emitState();
    return { ok: true, record };
  }

  /**
   * Panel update: replace host/port/user and optionally replace the secret
   * (new secret → same reference slot is overwritten; auth type switch →
   * new reference allocated). `params.newName` renames the record when it
   * differs from the current key: live sessions of the old name are closed,
   * and the record moves to the new key. Credential references survive a
   * rename because they derive from the record's stable internal id.
   */
  async updateRecordWithSecrets(name, params) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    const newName = params.newName !== undefined ? String(params.newName).trim() : undefined;
    if (newName !== undefined && newName !== name) {
      if (!newName) return { ok: false, error: 'name must not be empty' };
      if (this.store.has(newName)) return { ok: false, error: `a connection named "${newName}" already exists` };
    }
    const hasSecret = ['password', 'privateKey', 'passphrase'].some((key) => typeof params[key] === 'string' && params[key] !== '');
    if (hasSecret) {
      const stored = await this.storeSecrets(record, params);
      if (!stored.ok) return stored;
      record.auth = stored.auth;
    }
    if (params.host !== undefined) record.host = String(params.host).trim();
    if (params.port !== undefined) record.port = Number(params.port);
    if (params.user !== undefined) record.user = String(params.user).trim();
    if (newName !== undefined && newName !== name) {
      // Close every live session of the old name (panel tabs + AI primary),
      // then move the record to the new key.
      const keys = [...this.sessions.entries()]
        .filter(([, session]) => session.record.name === name)
        .map(([key]) => key);
      for (const key of keys) await this.disconnectKey(key, { closeTab: true });
      for (const key of keys) this.sessions.delete(key);
      await this.store.remove(name);
      record.name = newName;
      // Keep other records' tunnel references pointing at the new name.
      for (const other of this.store.list()) {
        if (other.name !== newName && other.tunnel === name) {
          other.tunnel = newName;
          other.updatedAt = Date.now();
        }
      }
    }
    if (params.tunnel !== undefined) {
      const tunnel = normalizeTunnelInput(this.store, newName ?? name, params.tunnel);
      if (!tunnel.ok) return tunnel;
      record.tunnel = tunnel.value;
    }
    record.updatedAt = Date.now();
    await this.store.put(record);
    this.emitState();
    return { ok: true, record };
  }

  /**
   * Store form secrets under credential references derived from a record.
   * Existing reference slots are reused when the auth type matches, so an
   * edited secret replaces the old value in place.
   */
  async storeSecrets(record, input) {
    const password = typeof input.password === 'string' && input.password !== '' ? input.password : undefined;
    const privateKey = typeof input.privateKey === 'string' && input.privateKey !== '' ? input.privateKey : undefined;
    const passphrase = typeof input.passphrase === 'string' && input.passphrase !== '' ? input.passphrase : undefined;
    const existing = record.auth;

    if (password !== undefined && privateKey !== undefined) {
      return { ok: false, error: 'choose either password or private key auth, not both' };
    }
    if (password !== undefined) {
      const ref = existing?.type === 'password' && existing.passwordRef ? existing.passwordRef : credentialRefFor(record, 'PASSWORD');
      await this.deps.credentials.set(ref, password);
      return { ok: true, auth: { type: 'password', passwordRef: ref } };
    }
    if (privateKey !== undefined) {
      const keyRef = existing?.type === 'privateKey' && existing.privateKeyRef ? existing.privateKeyRef : credentialRefFor(record, 'KEY');
      await this.deps.credentials.set(keyRef, privateKey);
      let passphraseRef;
      if (passphrase !== undefined) {
        passphraseRef = existing?.type === 'privateKey' && existing.passphraseRef ? existing.passphraseRef : credentialRefFor(record, 'PASSPHRASE');
        await this.deps.credentials.set(passphraseRef, passphrase);
      }
      return { ok: true, auth: { type: 'privateKey', privateKeyRef: keyRef, passphraseRef } };
    }
    if (existing && existing.type === 'password') {
      return { ok: true, auth: existing };
    }
    if (existing && existing.type === 'privateKey') {
      return { ok: true, auth: existing };
    }
    return { ok: false, error: 'provide a password or a private key' };
  }

  /** Update editable fields of a record (name is the key and cannot change). */
  async updateRecord(name, patch) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    const next = { ...patch };
    const auth = normalizeAuthInput(next.auth);
    if (next.auth !== undefined && !auth) return { ok: false, error: 'invalid auth: use passwordRef / privateKeyPath / privateKeyRef (secrets must not be passed inline)' };
    if (next.host !== undefined) record.host = String(next.host).trim();
    if (next.port !== undefined) record.port = Number(next.port);
    if (next.user !== undefined) record.user = String(next.user).trim();
    if (auth !== undefined) record.auth = auth;
    record.updatedAt = Date.now();
    await this.store.put(record);
    this.emitState();
    return { ok: true, record };
  }

  /**
   * Delete a record: disconnect first when online, then remove.
   * @returns {ok:true} or {ok:false, error}.
   */
  async deleteRecord(name) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    // Close EVERY session of the record (primary + panel duplicates) and
    // drop their tabs.
    const keys = [...this.sessions.entries()]
      .filter(([, session]) => session.record.name === name)
      .map(([key]) => key);
    for (const key of keys) await this.disconnectKey(key, { closeTab: true });
    await this.store.remove(name);
    for (const key of keys) this.sessions.delete(key);
    // Drop tunnel references that pointed at the deleted connection.
    let cleaned = false;
    for (const other of this.store.list()) {
      if (other.tunnel === name) {
        other.tunnel = undefined;
        other.updatedAt = Date.now();
        cleaned = true;
      }
    }
    if (cleaned) await this.store.flush();
    this.emitState();
    return { ok: true };
  }

  /**
   * Transfer ownership user → ai (one-way). The record itself is unchanged
   * except its source; the live session (if online) keeps running and the
   * mutex rules start applying immediately.
   */
  async transferToAi(name) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    if (record.source !== 'user') return { ok: false, error: `connection "${name}" is not user-created; only user → ai transfer is supported` };
    record.source = 'ai';
    record.updatedAt = Date.now();
    await this.store.put(record);
    this.emitState();
    return { ok: true, record };
  }

  // ------------------------------------------------------------- connection

  /**
   * Get or create the PRIMARY session of a record (key = record name).
   * The model tools and the settings page address sessions by this key.
   */
  sessionOf(record) {
    let session = this.sessions.get(record.name);
    if (session === undefined) {
      session = new Session(this, record, record.name);
      this.sessions.set(record.name, session);
    }
    session.record = record;
    return session;
  }

  /**
   * Panel "open a saved connection" — creates a NEW tab/session:
   *  - the record's FIRST session is the primary one (shared with the AI,
   *    key = record name);
   *  - any further session is an independent duplicate (unique key) so the
   *    "+" dialog can always open a fresh connection, even while the same
   *    connection is already connected in another tab.
   * @returns {ok, key, name, tab?}.
   */
  async openNewSession(name) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    const primary = this.sessions.get(record.name);
    const key = primary !== undefined ? `${record.name}#${uid()}` : record.name;
    let session = this.sessions.get(key);
    if (session === undefined) {
      session = new Session(this, record, key);
      this.sessions.set(key, session);
    }
    session.record = record;
    if (session.status === STATUS_RECONNECTING) session.clearReconnect();
    const result = await this.ensureConnected(session, { waitForReconnectMs: 0 });
    this.openTab(key);
    return {
      ok: result.ok,
      key,
      name: record.name,
      status: session.status,
      error: result.error,
      tab: session.statusPublic(),
    };
  }

  /** Session by key (panel tabs; undefined when the tab is gone). */
  sessionByKey(key) {
    return this.sessions.get(String(key ?? ''));
  }

  /**
   * Ensure a record's session is online.
   * @param options - {waitForReconnectMs, signal}.
   * @returns {ok:true} or {ok:false, status?, error?}.
   */
  async ensureConnected(session, { waitForReconnectMs = 0, signal } = {}) {
    if (session.status === STATUS_CONNECTED) return { ok: true };
    if (session.status === STATUS_CONNECTING && session.connectPromise) {
      try {
        await session.connectPromise;
      } catch { /* handled below */ }
      if (session.status === STATUS_CONNECTED) return { ok: true };
    }
    if (session.status === STATUS_RECONNECTING && !session.isExplicit()) {
      if (waitForReconnectMs > 0) {
        const deadline = Date.now() + waitForReconnectMs;
        while (session.status === STATUS_RECONNECTING && !session.isExplicit()) {
          if (signal?.aborted) return { ok: false, error: 'aborted', status: session.status };
          if (Date.now() >= deadline) break;
          await sleep(150, signal);
        }
        if (session.status === STATUS_CONNECTED) return { ok: true };
        if (session.status === STATUS_RECONNECTING) {
          return {
            ok: false,
            status: STATUS_RECONNECTING,
            error: `connection "${session.record.name}" is reconnecting (attempt ${session.reconnectAttempts}); try again later or increase waitForReconnectMs`,
          };
        }
      } else {
        // Fresh explicit attempt while the backoff is running.
        session.clearReconnect();
      }
    }
    return this.doConnect(session, { signal, isReconnect: session.status === STATUS_RECONNECTING });
  }

  /**
   * Establish (or re-establish) the SSH connection of a session.
   * @returns {ok:true} or {ok:false, status, error}.
   */
  async doConnect(session, { signal, isReconnect = false } = {}) {
    if (session.connectPromise) return session.connectPromise;
    const record = session.record;
    const auth = await this.resolveAuth(record);
    if (!auth.ok) {
      session.lastError = auth.error;
      session.status = STATUS_ERROR;
      session.wasReconnecting = false;
      this.notifyNotice(session, `connection error: ${auth.error}`);
      this.emitState();
      return { ok: false, status: STATUS_ERROR, error: auth.error };
    }
    // Resolve the SSH tunnel chain (jump hosts) when the record uses one.
    // The clients stay acquired for the session lifetime; failed attempts
    // release them in `settle`.
    let tunnelClients = [];
    if (record.tunnel) {
      const chain = await this.acquireTunnelChain(record, session.key);
      if (!chain.ok) {
        session.lastError = chain.error;
        session.status = STATUS_ERROR;
        session.wasReconnecting = false;
        this.notifyNotice(session, `connection error: ${chain.error}`);
        this.emitState();
        return { ok: false, status: STATUS_ERROR, error: chain.error };
      }
      tunnelClients = chain.clients;
    }
    session.explicitClose = false;
    session.status = STATUS_CONNECTING;
    session.lastError = null;
    session.wasReconnecting = isReconnect;
    this.emitState();

    const promise = new Promise((resolve) => {
      const client = new Client();
      const timeoutMs = this.config.connectTimeoutMs;
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (session.connectTimer !== null) {
          clearTimeout(session.connectTimer);
          session.connectTimer = null;
        }
        session.connectPromise = null;
        // Failed attempts give the tunnel chain back immediately; successful
        // sessions release it on explicit disconnect (disconnectKey).
        if (!value.ok && tunnelClients.length > 0) {
          void this.releaseTunnelChain(record, session.key);
        }
        resolve(value);
      };
      session.connectTimer = setTimeout(() => {
        try {
          client.end();
        } catch { /* ignore */ }
        const message = `connection to ${record.host}:${record.port} timed out after ${timeoutMs} ms`;
        session.lastError = message;
        if (isReconnect) {
          session.status = STATUS_RECONNECTING;
        } else {
          session.status = STATUS_ERROR;
          this.notifyNotice(session, `connection error: ${message}`);
        }
        this.emitState();
        settle({ ok: false, status: session.status, error: message });
      }, timeoutMs + 500);

      const secrets = auth.secrets ?? [];
      let becameReady = false;
      client.on('ready', () => {
        becameReady = true;
        session.client = client;
        session.status = STATUS_CONNECTED;
        session.connectedAt = Date.now();
        session.reconnectAttempts = 0;
        session.lastError = null;
        const reconnected = session.wasReconnecting;
        session.wasReconnecting = false;
        this.openTab(session.key);
        this.notifyNotice(
          session,
          reconnected
            ? `reconnected to ${record.user}@${record.host}:${record.port} — the shell state was reset`
            : `connected to ${record.user}@${record.host}:${record.port}`,
        );
        // Start the persistent interactive shell; its banner/motd/prompt flow
        // straight into the terminal.
        this.spawnShell(session);
        this.emitState();
        settle({ ok: true });
      });
      client.on('error', (error) => {
        const message = readableError(error, secrets);
        session.lastError = message;
        if (isReconnect) {
          if (session.status !== STATUS_RECONNECTING) session.status = STATUS_RECONNECTING;
          return; // the reconnect loop owns the outcome
        }
        if (session.isExplicit()) {
          settle({ ok: true, status: STATUS_DISCONNECTED });
          return;
        }
        if (session.status === STATUS_CONNECTED) {
          // Established connection erroring — the close handler drives
          // auto-reconnect; keep the state visible until then.
          return;
        }
        session.status = STATUS_ERROR;
        this.notifyNotice(session, `connection error: ${message}`);
        this.emitState();
        settle({ ok: false, status: STATUS_ERROR, error: message });
      });
      client.on('close', () => {
        if (session.client === client) session.client = null;
        // The shared shell dies with its connection.
        if (session.shellStream !== null) {
          session.shellStream = null;
        }
        if (session.resizeTimer !== null) {
          clearTimeout(session.resizeTimer);
          session.resizeTimer = null;
        }
        // Kill only commands that ran on THIS client — a stale client's close
        // must never touch commands already running on a newer connection.
        for (const cmd of [...session.activeCommands.values()]) {
          if (cmd.client === client) cmd.finish({ killed: true });
        }
        if (session.isExplicit() || this.disposed) {
          session.status = STATUS_DISCONNECTED;
          this.emitState();
          settle({ ok: true, status: STATUS_DISCONNECTED });
          return;
        }
        if (becameReady) {
          // Unexpected drop of an established connection → auto-reconnect.
          this.startReconnect(session);
          settle({ ok: true, status: session.status });
          return;
        }
        // The attempt never became ready: report failure (the reconnect loop
        // owns the next step when isReconnect).
        if (isReconnect) {
          session.status = STATUS_RECONNECTING;
          settle({ ok: false, status: STATUS_RECONNECTING, error: session.lastError ?? 'connection failed' });
          return;
        }
        session.status = STATUS_ERROR;
        session.lastError = session.lastError ?? 'connection closed during handshake';
        this.notifyNotice(session, `connection error: ${session.lastError}`);
        this.emitState();
        settle({ ok: false, status: STATUS_ERROR, error: session.lastError });
      });

      const connectTarget = (sock) => {
        const connectOpts = {
          host: record.host,
          port: record.port,
          username: record.user,
          readyTimeout: timeoutMs,
          keepaliveInterval: this.config.heartbeatIntervalMs,
          keepaliveCountMax: this.config.keepaliveCountMax,
          ...auth.connectOpts,
        };
        if (sock !== undefined) connectOpts.sock = sock;
        try {
          client.connect(connectOpts);
        } catch (error) {
          session.lastError = readableError(error, secrets);
          session.status = STATUS_ERROR;
          this.emitState();
          settle({ ok: false, status: STATUS_ERROR, error: session.lastError });
        }
      };
      if (tunnelClients.length > 0) {
        // Open a direct-tcpip channel through the innermost tunnel hop; the
        // target connection rides that stream.
        const hop = tunnelClients[tunnelClients.length - 1];
        hop.forwardOut('127.0.0.1', 0, record.host, record.port, (error, stream) => {
          if (error) {
            const message = `tunnel "${record.tunnel}": ${readableError(error, secrets)}`;
            session.lastError = message;
            if (isReconnect) {
              session.status = STATUS_RECONNECTING;
            } else {
              session.status = STATUS_ERROR;
              this.notifyNotice(session, `connection error: ${message}`);
            }
            this.emitState();
            settle({ ok: false, status: session.status, error: message });
            return;
          }
          connectTarget(stream);
        });
      } else {
        connectTarget(undefined);
      }
      if (signal?.aborted) {
        try {
          client.end();
        } catch { /* ignore */ }
      }
    });
    session.connectPromise = promise;
    return promise;
  }

  /**
   * Open the persistent interactive shell (login shell over a real pty) for a
   * connected session. Its output — motd, prompt, echo of typed input — is
   * streamed into the terminal as user-source output.
   */
  spawnShell(session) {
    const client = session.client;
    if (!client || session.shellStream || this.disposed) return;
    client.shell({
      term: 'xterm-256color',
      rows: session.shellRows,
      cols: session.shellCols,
      height: session.shellRows * 18,
      width: session.shellCols * 9,
    }, (error, stream) => {
      if (error) {
        session.lastError = `shell: ${readableError(error)}`;
        this.emitState();
        return;
      }
      session.shellStream = stream;
      stream.on('data', (data) => {
        session.shellLastActivity = Date.now();
        session.appendEntry(ENTRY_OUT, data.toString('utf8'), { source: 'user' });
      });
      stream.on('close', () => {
        if (session.shellStream !== stream) return;
        session.shellStream = null;
        // The shell ended (e.g. the user typed `exit`) but the SSH connection
        // is still healthy → start a fresh shell so the tab stays usable.
        if (!session.isExplicit() && !this.disposed && session.client === client) {
          this.notifyNotice(session, 'shell exited — starting a fresh shell');
          this.emitState();
          setTimeout(() => this.spawnShell(session), 500);
        }
      });
      stream.on('error', () => { /* the close handler above owns the outcome */ });
      this.emitState();
    });
  }

  /**
   * Feed user keystrokes straight into the shared interactive shell.
   * While an AI command runs on an ai-source connection the input is dropped
   * (input mutex). Returns {ok} / {ok:false, blocked?/error?}.
   * @param key - the tab/session key (record name for the primary session).
   */
  input(key, data) {
    const session = this.sessionByKey(key);
    if (!session) return { ok: false, error: `no live session for "${key}"` };
    const record = session.record;
    if (session.status !== STATUS_CONNECTED) {
      return { ok: false, error: `connection "${record.name}" is not connected` };
    }
    if (!session.shellStream) {
      return { ok: false, error: `connection "${record.name}" is connected but its interactive shell is not ready yet` };
    }
    if (record.source === 'ai' && session.activeCommands.size > 0) {
      return {
        ok: false,
        blocked: true,
        error: 'AI is running a command on this connection — typing is disabled until it finishes',
      };
    }
    const text = String(data ?? '');
    if (text === '') return { ok: true };
    try {
      session.shellStream.write(text);
    } catch (error) {
      return { ok: false, error: readableError(error) };
    }
    session.shellLastActivity = Date.now();
    return { ok: true };
  }

  /** Keystrokes for a session by tab key (panel). */
  inputByKey(key, data) {
    return this.input(key, data);
  }

  /**
   * Resize the shared shell pty (panel terminal geometry).
   *
   * The pty is NOT resized immediately: a resize while the user is typing
   * makes readline redraw the current input line mid-echo (`\r` bytes land
   * inside the echoed text and garble the terminal). The new size is applied
   * only once the shell has been quiet for the full quiet window, so redraws
   * only ever happen on an idle prompt.
   */
  resize(key, cols, rows) {
    const session = this.sessionByKey(key);
    if (!session) return { ok: false, error: `no live session for "${key}"` };
    session.shellCols = Math.max(20, Math.min(500, Math.floor(Number(cols) || 160)));
    session.shellRows = Math.max(5, Math.min(200, Math.floor(Number(rows) || 40)));
    this.scheduleShellResize(session);
    return { ok: true };
  }

  /** Apply the pending pty size once the shell is quiet (coalesced). */
  scheduleShellResize(session) {
    if (session.resizeTimer !== null) return; // a resize is already pending
    const attempt = () => {
      session.resizeTimer = null;
      const stream = session.shellStream;
      if (!stream || stream.destroyed || session.isExplicit() || this.disposed) return;
      if (Date.now() - session.shellLastActivity < this.config.shellQuietWaitMs) {
        // The shell is (or was just) active — retry after the quiet window.
        session.resizeTimer = setTimeout(attempt, 400);
        return;
      }
      try {
        stream.setWindow(session.shellRows, session.shellCols, session.shellRows * 18, session.shellCols * 9);
      } catch { /* pty already gone */ }
    };
    session.resizeTimer = setTimeout(attempt, 60);
  }

  /** Start the exponential-backoff reconnect loop after an unexpected drop. */
  startReconnect(session) {
    if (session.isExplicit() || this.disposed || session.status === STATUS_RECONNECTING) return;
    session.status = STATUS_RECONNECTING;
    session.reconnectAttempts = 1;
    session.wasReconnecting = true;
    this.notifyNotice(session, 'connection lost — reconnecting…');
    this.emitState();
    const attempt = () => {
      if (session.isExplicit() || this.disposed) return;
      if (session.reconnectAttempts > this.config.reconnectMaxAttempts) {
        session.clearReconnect();
        session.status = STATUS_DISCONNECTED;
        session.wasReconnecting = false;
        session.lastError = `auto-reconnect failed after ${session.reconnectAttempts - 1} attempts`;
        this.notifyNotice(session, session.lastError);
        this.emitState();
        return;
      }
      session.connectPromise = null;
      this.doConnect(session, { isReconnect: true }).then((result) => {
        if (result.ok || session.isExplicit() || this.disposed) return;
        // The connect attempt failed; schedule the next backoff step.
        if (session.status !== STATUS_RECONNECTING) session.status = STATUS_RECONNECTING;
        session.reconnectAttempts += 1;
        const delay = Math.min(
          this.config.reconnectBaseDelayMs * 2 ** (session.reconnectAttempts - 2),
          this.config.reconnectMaxDelayMs,
        );
        session.clearReconnect();
        session.reconnectTimer = setTimeout(attempt, delay);
        this.notifyNotice(session, `reconnect attempt ${session.reconnectAttempts - 1} failed — retrying in ${Math.round(delay / 1000)} s`);
        this.emitState();
      });
    };
    const delay = this.config.reconnectBaseDelayMs;
    session.reconnectTimer = setTimeout(attempt, delay);
  }

  /** Public connect by record name (settings page / tools / tests). */
  async connect(name) {
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    const session = this.sessionOf(record);
    if (session.status === STATUS_RECONNECTING) session.clearReconnect();
    const result = await this.ensureConnected(session, { waitForReconnectMs: 0 });
    this.openTab(session.key);
    return result;
  }

  /** Connect a specific SESSION by tab key (panel header reconnect). */
  async connectKey(key) {
    const session = this.sessionByKey(key);
    if (!session) return { ok: false, error: `no live session for "${key}"` };
    if (session.status === STATUS_RECONNECTING) session.clearReconnect();
    const result = await this.ensureConnected(session, { waitForReconnectMs: 0 });
    this.openTab(key);
    return result;
  }

  /** Explicit disconnect of the PRIMARY session — never auto-reconnects. */
  async disconnect(name, { closeTab = false } = {}) {
    return this.disconnectKey(name, { closeTab });
  }

  /** Explicit disconnect of one session by tab key. */
  async disconnectKey(key, { closeTab = false } = {}) {
    const session = this.sessions.get(key);
    if (session === undefined) {
      if (closeTab) this.closeTabOnly(key);
      this.emitState();
      return { ok: true };
    }
    session.explicitClose = true;
    session.clearReconnect();
    if (session.connectTimer !== null) clearTimeout(session.connectTimer);
    for (const cmd of session.activeCommands.values()) cmd.finish({ killed: true });
    this.closeShell(session);
    const client = session.client;
    session.client = null;
    if (client) {
      try {
        client.end();
      } catch { /* ignore */ }
    }
    if (session.record.tunnel) await this.releaseTunnelChain(session.record, session.key);
    session.status = STATUS_DISCONNECTED;
    session.wasReconnecting = false;
    this.notifyNotice(session, 'disconnected');
    if (closeTab) this.closeTabOnly(key);
    this.emitState();
    return { ok: true };
  }

  /** User closed a tab (by session key): disconnect immediately, drop the tab. */
  async closeTab(key) {
    return this.disconnectKey(key, { closeTab: true });
  }

  /** Open a tab (no-op when already open); emits state. */
  openTab(name) {
    if (!this.tabs.includes(name)) {
      this.tabs.push(name);
      this.emitState();
    }
  }

  /** Remove a tab without touching the connection. */
  closeTabOnly(name) {
    const index = this.tabs.indexOf(name);
    if (index !== -1) {
      this.tabs.splice(index, 1);
      this.emitState();
    }
  }

  notifyNotice(session, text) {
    session.appendEntry(ENTRY_NOTICE, text);
  }

  /** Close the session's shared shell channel (if any). */
  closeShell(session) {
    if (session.resizeTimer !== null) {
      clearTimeout(session.resizeTimer);
      session.resizeTimer = null;
    }
    const stream = session.shellStream;
    session.shellStream = null;
    if (stream && !stream.destroyed) {
      try {
        stream.close();
      } catch { /* already closing */ }
    }
  }

  // -------------------------------------------------------------- tunnels

  /**
   * Resolve the tunnel chain needed to reach a record's host: the ordered
   * list of tunnel clients [outermost, ..., innermost] following
   * `record.tunnel` recursively (tunnel records may themselves use tunnels).
   * Clients are shared per tunnel record and refcounted per session key;
   * release them with releaseTunnelChain.
   * @returns {ok:true, clients: Client[]} or {ok:false, error}.
   */
  async acquireTunnelChain(record, sessionKey, visited = new Set()) {
    if (!record.tunnel) return { ok: true, clients: [] };
    if (visited.has(record.name)) {
      return { ok: false, error: `SSH tunnel cycle detected: ${[...visited, record.name].join(' \u2192 ')}` };
    }
    if (visited.size >= 8) return { ok: false, error: 'SSH tunnel chain too deep (max 8 hops)' };
    visited.add(record.name);
    const tunnelRecord = this.store.get(record.tunnel);
    if (tunnelRecord === undefined) {
      return { ok: false, error: `tunnel connection "${record.tunnel}" is not saved` };
    }
    const inner = await this.acquireTunnelChain(tunnelRecord, sessionKey, visited);
    if (!inner.ok) return inner;
    const hop = await this.acquireTunnelClient(tunnelRecord, sessionKey, inner.clients);
    if (!hop.ok) return hop;
    return { ok: true, clients: [...inner.clients, hop.client] };
  }

  /**
   * Get-or-create the shared client connected to `record`, routed through
   * `hops` when the tunnel record itself uses a tunnel. One client per
   * tunnel record; concurrent acquisitions for the same record share the
   * same in-flight connection.
   */
  async acquireTunnelClient(record, sessionKey, hops) {
    const entry = this.tunnelClients.get(record.name);
    if (entry !== undefined) {
      entry.sessions.add(sessionKey);
      return { ok: true, client: entry.client };
    }
    let pending = this.tunnelPending.get(record.name);
    if (pending === undefined) {
      pending = this.connectTunnelClient(record, hops ?? []);
      this.tunnelPending.set(record.name, pending);
      const done = () => {
        if (this.tunnelPending.get(record.name) === pending) this.tunnelPending.delete(record.name);
      };
      pending.then(done, done);
    }
    const result = await pending;
    if (!result.ok) return result;
    const current = this.tunnelClients.get(record.name);
    if (current !== undefined) {
      current.sessions.add(sessionKey);
      return { ok: true, client: current.client };
    }
    this.tunnelClients.set(record.name, { client: result.client, sessions: new Set([sessionKey]) });
    return { ok: true, client: result.client };
  }

  /** Establish one tunnel client (directly, or through its own hops). */
  async connectTunnelClient(record, hops) {
    let auth;
    try {
      auth = await this.resolveAuth(record);
    } catch (error) {
      return { ok: false, error: `tunnel "${record.name}": ${readableError(error)}` };
    }
    if (!auth.ok) return { ok: false, error: `tunnel "${record.name}": ${auth.error}` };
    const secrets = auth.secrets ?? [];
    return new Promise((resolve) => {
      const client = new Client();
      let settled = false;
      const settle = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        try {
          client.end();
        } catch { /* ignore */ }
        settle({ ok: false, error: `tunnel "${record.name}": connect timed out after ${this.config.connectTimeoutMs} ms` });
      }, this.config.connectTimeoutMs + 500);
      client.on('ready', () => {
        clearTimeout(timer);
        settle({ ok: true, client });
      });
      client.on('error', (error) => {
        clearTimeout(timer);
        settle({ ok: false, error: `tunnel "${record.name}": ${readableError(error, secrets)}` });
      });
      client.on('close', () => {
        // A dead tunnel is dropped from the cache; sessions re-acquire it on
        // their next (re)connect attempt.
        this.tunnelClients.delete(record.name);
      });
      const connectThrough = (sock) => {
        const opts = {
          host: record.host,
          port: record.port,
          username: record.user,
          readyTimeout: this.config.connectTimeoutMs,
          keepaliveInterval: this.config.heartbeatIntervalMs,
          keepaliveCountMax: this.config.keepaliveCountMax,
          ...auth.connectOpts,
        };
        if (sock !== undefined) opts.sock = sock;
        try {
          client.connect(opts);
        } catch (error) {
          clearTimeout(timer);
          settle({ ok: false, error: `tunnel "${record.name}": ${readableError(error, secrets)}` });
        }
      };
      if (hops.length > 0) {
        const hop = hops[hops.length - 1];
        hop.forwardOut('127.0.0.1', 0, record.host, record.port, (error, stream) => {
          if (error) {
            clearTimeout(timer);
            settle({ ok: false, error: `tunnel "${record.name}": ${readableError(error, secrets)}` });
            return;
          }
          connectThrough(stream);
        });
      } else {
        connectThrough(undefined);
      }
    });
  }

  /**
   * Release the session's reference on every tunnel client in its chain;
   * clients with no remaining users are closed.
   */
  async releaseTunnelChain(record, sessionKey, visited = new Set()) {
    if (!record.tunnel || visited.has(record.name)) return;
    visited.add(record.name);
    const tunnelRecord = this.store.get(record.tunnel);
    if (tunnelRecord !== undefined) await this.releaseTunnelChain(tunnelRecord, sessionKey, visited);
    const entry = this.tunnelClients.get(record.tunnel);
    if (entry === undefined) return;
    entry.sessions.delete(sessionKey);
    if (entry.sessions.size === 0) {
      this.tunnelClients.delete(record.tunnel);
      try {
        entry.client.end();
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ exec

  /**
   * AI command execution with mutex + reconnect wait (ai-source only; the
   * caller must already have verified source).
   * @param input - {connection, command, timeoutMs?, waitForIdleMs?, waitForReconnectMs?, signal}.
   * @returns command outcome {ok, status, exitCode?, output?, execId?, error?}.
   */
  async aiExec(input) {
    const name = String(input.connection ?? '').trim();
    const record = this.store.get(name);
    if (!record) return { ok: false, error: `no saved connection named "${name}"` };
    if (record.source !== 'ai') {
      return { ok: false, error: `connection "${name}" was created by the user; AI cannot access it` };
    }
    const session = this.sessionOf(record);
    const connected = await this.ensureConnected(session, {
      waitForReconnectMs: input.waitForReconnectMs ?? this.config.reconnectWaitTimeoutMs,
      signal: input.signal,
    });
    if (!connected.ok) {
      return { ok: false, status: connected.status ?? STATUS_ERROR, error: connected.error };
    }

    // Execution mutex (ai-source): wait for the shared interactive shell to
    // fall quiet (no output and no input for shellQuietWaitMs), then run.
    const quietMs = this.config.shellQuietWaitMs;
    const idleWait = input.waitForIdleMs ?? this.config.busyWaitTimeoutMs;
    const deadline = Date.now() + idleWait;
    const isQuiet = () => {
      if (session.activeCommands.size > 0) return false;
      return Date.now() - session.shellLastActivity >= quietMs;
    };
    while (!isQuiet()) {
      if (input.signal?.aborted) return { ok: false, status: 'aborted', error: 'aborted by caller' };
      if (Date.now() >= deadline) {
        return {
          ok: false,
          status: 'busy',
          error: `connection "${name}" is busy (the terminal shell is still active); wait for it to finish or try again later`,
        };
      }
      await sleep(100, input.signal);
    }

    const { ok, cmd } = await this.runCommand(session, { kind: 'ai', command: input.command, signal: input.signal });
    if (!ok) return { ok: false, error: cmd };
    return this.awaitCommandResult(cmd, { timeoutMs: input.timeoutMs, signal: input.signal });
  }

  /**
   * Start one command on a session via a dedicated exec channel. Resolves as
   * soon as the channel is established (the command keeps running in the
   * background); callers await completion through awaitCommandResult.
   * @returns {ok:true, cmd} or {ok:false, error}.
   */
  runCommand(session, { kind, command, signal }) {
    const client = session.client;
    if (!client) return Promise.resolve({ ok: false, error: `connection "${session.record.name}" is not online` });
    const cmd = new Cmd(session, kind, command);
    cmd.client = client;
    session.activeCommands.set(cmd.execId, cmd);
    this.execRegistry.set(cmd.execId, cmd);
    session.appendEntry(ENTRY_START, command, { source: kind, execId: cmd.execId });
    // The panel must see the busy state immediately (input mutex).
    this.emitState();

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finish = (extra) => {
        cmd.finish(extra);
        if (extra.error) {
          session.appendEntry(ENTRY_END, `error: ${extra.error}`, { source: kind, execId: cmd.execId });
        } else if (cmd.killed) {
          session.appendEntry(ENTRY_END, 'killed', { source: kind, exitCode: null, execId: cmd.execId });
        } else {
          session.appendEntry(ENTRY_END, `exit code: ${cmd.exitCode ?? '?'}`, { source: kind, exitCode: cmd.exitCode, execId: cmd.execId });
        }
        this.emitState();
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (!cmd.done) {
          cmd.kill();
          finish({ killed: true });
        }
        settle({ ok: true, cmd });
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // A pty makes the command behave like a real terminal session: ANSI
        // color output, interactive programs, and reliable termination via
        // Ctrl-C (channel signals are not honored by several servers).
        client.exec(command, { pty: { rows: 40, cols: 160, term: 'xterm-256color' } }, (error, stream) => {
          if (error) {
            finish({ error: readableError(error) });
            settle({ ok: false, error: readableError(error) });
            return;
          }
          cmd.stream = stream;
          stream.on('data', (data) => {
            const text = data.toString('utf8');
            cmd.push(text, false);
            session.appendEntry(ENTRY_OUT, text, { source: kind, execId: cmd.execId });
          });
          if (stream.stderr) {
            stream.stderr.on('data', (data) => {
              cmd.push(data.toString('utf8'), true);
              session.appendEntry(ENTRY_OUT, data.toString('utf8'), { source: kind, execId: cmd.execId });
            });
          }
          stream.on('close', (code, signalName) => {
            finish({ exitCode: code, signal: signalName, killed: cmd.killed });
          });
          stream.on('error', (streamError) => {
            finish({ error: readableError(streamError) });
          });
          settle({ ok: true, cmd });
        });
      } catch (error) {
        finish({ error: readableError(error) });
        settle({ ok: false, error: readableError(error) });
      }
    });
  }

  /**
   * Wait for a command to finish (or the timeout), then build the tool result.
   */
  async awaitCommandResult(cmd, { timeoutMs, signal }) {
    const deadline = Date.now() + (timeoutMs ?? this.config.execTimeoutMs);
    while (!cmd.done) {
      if (signal?.aborted) {
        cmd.kill();
        cmd.finish({ killed: true });
        return { ok: false, status: 'aborted', error: 'aborted by caller' };
      }
      if (Date.now() >= deadline) {
        const cap = this.config.execOutputMaxBytes;
        const { text, truncated } = cmd.output(cap);
        return { ok: true, status: 'running', execId: cmd.execId, output: text, truncated };
      }
      await sleep(150, signal);
    }
    const cap = this.config.execOutputMaxBytes;
    const { text, truncated } = cmd.output(cap);
    if (cmd.error) return { ok: false, status: 'error', error: cmd.error, execId: cmd.execId, output: text, truncated };
    if (cmd.killed) return { ok: true, status: 'killed', execId: cmd.execId, output: text, truncated, message: 'command was killed' };
    return { ok: true, status: 'done', execId: cmd.execId, exitCode: cmd.exitCode, output: text, truncated };
  }

  /** Kill the running command on a session (panel kill button, by tab key). */
  killCommand(key) {
    const session = this.sessionByKey(key);
    if (!session) return { ok: false, error: `no live session for "${key}"` };
    const cmd = session.activeCommands.values().next().value;
    if (!cmd) return { ok: false, error: 'no command is running on this connection' };
    cmd.kill();
    return { ok: true, execId: cmd.execId, kind: cmd.kind };
  }

  /** Kill one exec by id (ssh_exec_kill tool). */
  async killExec(execId) {
    const cmd = this.execRegistry.get(execId);
    if (!cmd) return { ok: false, error: `no command with id "${execId}"` };
    if (cmd.done) return { ok: true, killed: false, execId, connection: cmd.session.record.name };
    const killed = cmd.kill();
    return { ok: true, killed, execId, connection: cmd.session.record.name };
  }

  /** Cap the exec registry: keep running commands plus the newest finished. */
  pruneExecRegistry() {
    const finished = [...this.execRegistry.values()]
      .filter((cmd) => cmd.done)
      .sort((a, b) => a.endedAt - b.endedAt);
    const excess = finished.length - 200;
    for (let i = 0; i < Math.max(0, excess); i++) {
      this.execRegistry.delete(finished[i].execId);
    }
  }

  /** Read one exec's output (ssh_exec_read tool). */
  execRead(execId, { tail } = {}) {
    const cmd = this.execRegistry.get(execId);
    if (!cmd) {
      return { ok: false, error: `no command with id "${execId}"` };
    }
    const cap = this.config.execOutputMaxBytes;
    const { text, truncated } = cmd.output(tail !== undefined ? tail : cap);
    return {
      ok: true,
      execId,
      connection: cmd.session.record.name,
      running: !cmd.done,
      done: cmd.done,
      exitCode: cmd.exitCode,
      killed: cmd.killed,
      output: text,
      truncated,
      message: cmd.error ?? undefined,
    };
  }

  /** Terminal backlog for a tab (panel, by session key). */
  terminalSnapshot(key, since = 0) {
    const session = this.sessionByKey(key);
    if (!session) return { entries: [] };
    return { entries: session.entries.filter((entry) => entry.seq > since) };
  }

  // ------------------------------------------------------------- ssh_connect

  /**
   * Model-facing connect: create a NEW ai record (fresh name) or re-establish
   * an existing ai record, optionally updating its auth.
   */
  async connectWithParams(params) {
    const name = String(params.name ?? '').trim();
    const existingName = String(params.connection ?? '').trim();

    if (existingName) {
      const record = this.store.get(existingName);
      if (!record) return { ok: false, error: `no saved connection named "${existingName}"` };
      if (record.source !== 'ai') {
        return { ok: false, error: `connection "${existingName}" was created by the user; AI cannot access it` };
      }
      if (params.auth) {
        const auth = normalizeAuthInput(params.auth);
        if (!auth) return { ok: false, error: 'invalid auth: use passwordRef / privateKeyPath / privateKeyRef (secrets must not be passed inline)' };
        record.auth = auth;
        record.updatedAt = Date.now();
        await this.store.put(record);
      }
      const session = this.sessionOf(record);
      if (session.status === STATUS_RECONNECTING) session.clearReconnect();
      const result = await this.ensureConnected(session, { waitForReconnectMs: 0, signal: params.signal });
      return this.connectResult(record, session, result);
    }

    if (!name) return { ok: false, error: 'a connection name is required (either an existing `connection` name or a new `name`)' };
    if (!params.host) return { ok: false, error: 'host is required when creating a new connection' };
    if (!params.user) return { ok: false, error: 'user is required when creating a new connection' };
    // createRecord normalizes auth itself; passing the raw input here avoids
    // double-normalizing the descriptor (which would reject key auth).
    const created = await this.createRecord({ name, host: params.host, port: params.port, user: params.user, auth: params.auth, tunnel: params.tunnel, source: 'ai' });
    if (!created.ok) return created;
    const record = created.record;
    const session = this.sessionOf(record);
    const result = await this.ensureConnected(session, { waitForReconnectMs: 0, signal: params.signal });
    return this.connectResult(record, session, result);
  }

  connectResult(record, session, result) {
    if (!result.ok) {
      return { ok: false, error: result.error, connection: record.name, status: session.status };
    }
    return { ok: true, connection: record.name, status: session.status, record: record.toPublic() };
  }
}

/**
 * Normalize a tunnel reference (name of another saved connection used as an
 * SSH tunnel / jump host). Empty input means a direct connection. The tunnel
 * must exist and must not be the connection itself; chains and cycles are
 * resolved at connect time.
 * @param store - RecordStore (existence check).
 * @param selfName - the record's own name.
 * @param tunnel - raw input (string or undefined).
 * @returns {ok:true, value?: string} or {ok:false, error}.
 */
export function normalizeTunnelInput(store, selfName, tunnel) {
  const value = tunnel === undefined || tunnel === null ? '' : String(tunnel).trim();
  if (value === '') return { ok: true, value: undefined };
  if (value === selfName) return { ok: false, error: 'a connection cannot use itself as its SSH tunnel' };
  if (!store.has(value)) return { ok: false, error: `tunnel connection "${value}" is not saved` };
  return { ok: true, value };
}

/** Normalize tool/panel auth input into a store auth descriptor (refs only). */
export function normalizeAuthInput(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const has = (key) => auth[key] !== undefined && auth[key] !== null && String(auth[key]).trim() !== '';
  if (has('password') || has('privateKey')) return null; // inline secrets are rejected
  const isKey = has('privateKeyPath') || has('privateKeyRef');
  if (isKey) {
    return {
      type: 'privateKey',
      keyPath: has('privateKeyPath') ? String(auth.privateKeyPath).trim() : undefined,
      privateKeyRef: has('privateKeyRef') ? String(auth.privateKeyRef).trim() : undefined,
      passphraseRef: has('passphraseRef') ? String(auth.passphraseRef).trim() : undefined,
    };
  }
  if (has('passwordRef')) {
    return { type: 'password', passwordRef: String(auth.passwordRef).trim() };
  }
  return null;
}

export { ConnectionRecord, readableError, uid };
