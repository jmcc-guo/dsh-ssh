/**
 * @jmcc-guo/dsh-ssh — durable connection-record store and credential
 * plumbing.
 *
 * Connection records are JSON data keyed by the unique connection name. The
 * file at `$DSH_HOME/storages/dsh-ssh/connections.json` holds records only —
 * NEVER secret material. Secrets live in the DSH credential service
 * (`ctx.credentials`) under generated references such as
 * `DSH_SSH_<recordId>_PASSWORD`; the record keeps the reference name so the
 * value can be re-resolved per operation.
 *
 * All writes are atomic (temp file + rename) and serialized through one
 * in-process mutex so concurrent AI connects and panel edits cannot corrupt
 * the file.
 * @module @jmcc-guo/dsh-ssh/store
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Record id prefix used for generated credential references. */
const CRED_PREFIX = 'DSH_SSH';

/**
 * Sanitize an arbitrary connection name into a POSIX-shell-identifier
 * credential name fragment.
 * @param name - connection name (any string).
 * @returns uppercase [A-Z0-9_] fragment.
 */
export function sanitizeCredFragment(name) {
  const out = String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'CONN' : out.slice(0, 48);
}

/**
 * Build the store path: `$DSH_HOME/storages/dsh-ssh/connections.json`.
 * @param homeDir - override for the DSH home (tests); default from env.
 * @returns absolute path.
 */
export function defaultRecordsPath(homeDir) {
  const home = homeDir ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-ssh', 'connections.json');
}

/** One persisted connection record. Secrets are never stored here. */
export class ConnectionRecord {
  /**
   * @param init - record fields.
   */
  constructor(init) {
    /** Unique connection name — the storage key. */
    this.name = String(init.name);
    /** 'ai' (model-managed) or 'user' (panel-created). Immutable except transfer. */
    this.source = init.source === 'user' ? 'user' : 'ai';
    this.host = String(init.host);
    this.port = Number(init.port ?? 22);
    this.user = String(init.user);
    /** auth descriptor; never contains secret values. */
    this.auth = normalizeAuth(init.auth);
    this.createdAt = Number(init.createdAt ?? Date.now());
    this.updatedAt = Number(init.updatedAt ?? Date.now());
    /** Internal id used only for credential reference generation. */
    this.id = String(init.id ?? randomId());
  }

  /** Credential ref for the password, when password auth is used. */
  get passwordRef() {
    return this.auth.type === 'password' ? this.auth.passwordRef : undefined;
  }

  /** Public (wire-safe) projection — no credential references exposed. */
  toPublic() {
    return {
      name: this.name,
      source: this.source,
      host: this.host,
      port: this.port,
      user: this.user,
      authType: this.auth.type,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Full JSON projection (refs only) for persistence. */
  toJSON() {
    return {
      name: this.name,
      source: this.source,
      host: this.host,
      port: this.port,
      user: this.user,
      auth: this.auth,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      id: this.id,
    };
  }

  static fromJSON(value) {
    return new ConnectionRecord(value);
  }
}

/** Normalize an auth descriptor (references only). */
function normalizeAuth(auth) {
  const a = auth ?? {};
  const type = a.type === 'privateKey' ? 'privateKey' : 'password';
  if (type === 'privateKey') {
    return {
      type: 'privateKey',
      keyPath: a.keyPath !== undefined ? String(a.keyPath) : undefined,
      privateKeyRef: a.privateKeyRef !== undefined ? String(a.privateKeyRef) : undefined,
      passphraseRef: a.passphraseRef !== undefined ? String(a.passphraseRef) : undefined,
    };
  }
  return {
    type: 'password',
    passwordRef: a.passwordRef !== undefined ? String(a.passwordRef) : undefined,
  };
}

/** Short random id for credential reference generation. */
function randomId() {
  return randomBytes(6).toString('hex');
}

/** Build a credential reference for one record role. */
export function credentialRefFor(record, role) {
  const frag = sanitizeCredFragment(record.name);
  return `${CRED_PREFIX}_${record.id}_${frag}_${role}`;
}

/**
 * Durable record store: load/save with atomic rename and a serialized write
 * queue.
 */
export class RecordStore {
  /**
   * @param path - records file path.
   * @param logger - logging sink ({info,warn,error}).
   */
  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
    /** Map<name, ConnectionRecord> */
    this.records = new Map();
    this.writeQueue = Promise.resolve();
    this.loaded = false;
  }

  /** Load records from disk (missing/corrupt file starts empty). */
  load() {
    let raw;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      this.logger.warn('dsh-ssh: cannot read records file %s: %s', this.path, error.message);
      this.loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const item of list) {
        try {
          const record = ConnectionRecord.fromJSON(item);
          if (!record.name) continue;
          this.records.set(record.name, record);
        } catch (error) {
          this.logger.warn('dsh-ssh: skipping malformed record: %s', error.message);
        }
      }
    } catch (error) {
      this.logger.warn('dsh-ssh: records file corrupt (%s); starting empty', error.message);
    }
    this.loaded = true;
  }

  /** All records, insertion order. */
  list() {
    return [...this.records.values()];
  }

  /**
   * @param name - unique connection name.
   * @returns the record or undefined.
   */
  get(name) {
    return this.records.get(String(name));
  }

  /** @returns whether a name is already taken by ANY source. */
  has(name) {
    return this.records.has(String(name));
  }

  /** Persist one record and enqueue a durable write. */
  async put(record) {
    this.records.set(record.name, record);
    await this.flush();
  }

  /** Remove one record and enqueue a durable write. */
  async remove(name) {
    this.records.delete(String(name));
    await this.flush();
  }

  /** Serialized, atomic persist of the whole table. */
  flush() {
    this.writeQueue = this.writeQueue.then(() => {
      const payload = JSON.stringify({ version: 1, records: this.list().map((r) => r.toJSON()) }, null, 2);
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        writeFileSync(tmp, payload, 'utf8');
        renameSync(tmp, this.path);
      } catch (error) {
        try {
          // Best-effort cleanup of the temp file on failure.
          // eslint-disable-next-line no-unused-expressions
          void error;
        } catch { /* ignore */ }
        this.logger.error('dsh-ssh: failed to persist records: %s', error.message);
      }
    }).catch(() => { /* keep queue alive */ });
    return this.writeQueue;
  }
}
