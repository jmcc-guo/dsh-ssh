/**
 * Focused rename test for updateRecordWithSecrets(newName): key move,
 * credential survival, collision/empty rejection, same-name no-op,
 * persistence across manager re-instantiation. No live SSH server needed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-rename-'));
const credentials = new Map();
const deps = {
  logger: { info() {}, warn() {}, error() {} },
  credentials: {
    async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
    async describe(ref) { return { configured: credentials.has(String(ref)), writable: true }; },
    async set(ref, value) { credentials.set(String(ref), value); },
    async unset(ref) { credentials.delete(String(ref)); },
  },
};
const config = { recordsPath: join(HOME, 'storages', 'dsh-ssh', 'connections.json') };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`);
}

const manager = new SshManager(deps, config);
manager.initialize();

// Create a user record with a password (exactly what the panel form does).
const created = await manager.createRecordWithSecrets({ name: 'old-box', host: '10.0.0.5', port: 22, user: 'root', password: 's3cret' });
check('create old-box', created.ok, created.error ?? '');
const oldRef = created.record.auth.passwordRef;

// Rename + change host in one edit.
const renamed = await manager.updateRecordWithSecrets('old-box', { name: 'old-box', newName: 'new-box', host: '10.0.0.6' });
check('rename ok', renamed.ok && renamed.record.name === 'new-box', JSON.stringify(renamed).slice(0, 160));
check('old key gone', manager.store.get('old-box') === undefined);
const renamedRecord = manager.store.get('new-box');
check('same id kept', !!renamedRecord && renamedRecord.id === created.record.id);
check('same credential ref kept', !!renamedRecord && renamedRecord.auth.passwordRef === oldRef);
check('host updated', !!renamedRecord && renamedRecord.host === '10.0.0.6');
const resolved = renamedRecord ? await deps.credentials.resolve(renamedRecord.auth.passwordRef) : undefined;
check('credential value survives rename', resolved?.value === 's3cret');

// Collision with an existing name is rejected.
await manager.createRecordWithSecrets({ name: 'other', host: '10.0.0.7', port: 22, user: 'root', password: 'x' });
const collision = await manager.updateRecordWithSecrets('new-box', { name: 'new-box', newName: 'other' });
check('collision rejected', !collision.ok && /already exists/.test(collision.error ?? ''), collision.error ?? '');
check('collision left record intact', manager.store.get('new-box')?.name === 'new-box' && manager.store.get('other')?.name === 'other');

// Whitespace-only name rejected.
const empty = await manager.updateRecordWithSecrets('new-box', { name: 'new-box', newName: '   ' });
check('empty name rejected', !empty.ok, empty.error ?? '');

// Same-name update is a plain field update, no key move.
const same = await manager.updateRecordWithSecrets('new-box', { name: 'new-box', newName: 'new-box' });
check('same-name update ok', same.ok && same.record.name === 'new-box', same.error ?? '');

// Unknown record still errors.
const missing = await manager.updateRecordWithSecrets('nope', { name: 'nope', newName: 'x' });
check('missing record rejected', !missing.ok, missing.error ?? '');

// Persistence across "restart": a fresh manager over the same file.
const manager2 = new SshManager(deps, config);
manager2.initialize();
check('persisted under new key', manager2.store.get('new-box') !== undefined && manager2.store.get('old-box') === undefined);

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`);
rmSync(HOME, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
