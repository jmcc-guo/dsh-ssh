/**
 * Offline logic test for the SSH-tunnel feature (no real SSH server needed).
 *
 * Exercises record-level tunnel validation (missing / self / clear), rename
 * and delete reference following, tunnel-chain cycle detection, and the
 * failure path that must release acquired tunnel clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-tunnel-'));

const credentials = new Map();
const fakeCredentials = {
  async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
  async set(ref, value) { credentials.set(String(ref), value); },
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const manager = new SshManager(
  { credentials: fakeCredentials, logger },
  { connectTimeoutMs: 300, heartbeatIntervalMs: 30000 },
  HOME,
);
manager.initialize();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Fixtures: jump host "gw" and target "app".
let r = await manager.createRecordWithSecrets({ name: 'gw', host: '10.0.0.1', port: 22, user: 'root', password: 'gw-secret' });
check('create jump host record', r.ok, r.error);
r = await manager.createRecordWithSecrets({ name: 'app', host: '10.0.0.2', port: 22, user: 'deploy', password: 'app-secret' });
check('create target record (direct)', r.ok, r.error);
check('target has no tunnel by default', r.record.tunnel === undefined);

// Attach a tunnel to the target.
r = await manager.updateRecordWithSecrets('app', { name: 'app', tunnel: 'gw' });
check('set tunnel on target', r.ok && r.record.tunnel === 'gw', r.error);
check('public projection carries tunnel', manager.statusOf('app').tunnel === 'gw');

// Validation errors.
r = await manager.updateRecordWithSecrets('app', { name: 'app', tunnel: 'nope' });
check('unknown tunnel rejected', !r.ok && r.error.includes('not saved'), r.error);
r = await manager.updateRecordWithSecrets('gw', { name: 'gw', tunnel: 'gw' });
check('self-tunnel rejected', !r.ok && r.error.includes('itself'), r.error);
r = await manager.createRecordWithSecrets({ name: 'bad', host: 'h', user: 'u', password: 'p', tunnel: 'missing' });
check('create with unknown tunnel rejected', !r.ok && r.error.includes('not saved'), r.error);

// Clearing the tunnel.
r = await manager.updateRecordWithSecrets('app', { name: 'app', tunnel: '' });
check('empty tunnel clears the field', r.ok && r.record.tunnel === undefined, r.error);

// Rename the jump host → target reference follows.
r = await manager.updateRecordWithSecrets('app', { name: 'app', tunnel: 'gw' });
check('re-attach tunnel', r.ok, r.error);
r = await manager.updateRecordWithSecrets('gw', { name: 'gw', newName: 'gw2' });
check('rename jump host', r.ok, r.error);
check('target tunnel ref follows rename', manager.store.get('app').tunnel === 'gw2');

// Delete the jump host → target reference is dropped.
r = await manager.deleteRecord('gw2');
check('delete jump host', r.ok, r.error);
check('target tunnel ref dropped on delete', manager.store.get('app').tunnel === undefined);

// Chain cycle detection at connect time (pure logic — no network).
credentials.set('P1', 'secret-1');
credentials.set('P2', 'secret-2');
r = await manager.createRecord({ name: 'cyc-a', host: '10.0.0.3', user: 'u', auth: { passwordRef: 'P1' }, source: 'ai' });
check('create cyc-a', r.ok, r.error);
r = await manager.createRecord({ name: 'cyc-b', host: '10.0.0.4', user: 'u', auth: { passwordRef: 'P2' }, source: 'ai' });
check('create cyc-b', r.ok, r.error);
r = await manager.updateRecordWithSecrets('cyc-a', { name: 'cyc-a', tunnel: 'cyc-b' });
check('cyc-a tunnels via cyc-b', r.ok, r.error);
r = await manager.updateRecordWithSecrets('cyc-b', { name: 'cyc-b', tunnel: 'cyc-a' });
check('cyc-b tunnels via cyc-a', r.ok, r.error);
r = await manager.connect('cyc-a');
check('cycle rejected at connect', !r.ok && r.error.includes('cycle'), r.error);
check('no tunnel clients leaked after cycle', manager.tunnelClients.size === 0);

// Connect failure through an unreachable tunnel releases the tunnel client.
r = await manager.createRecordWithSecrets({ name: 'dead', host: '10.255.255.1', port: 22, user: 'root', password: 'x' });
check('create unreachable jump host record', r.ok, r.error);
r = await manager.updateRecordWithSecrets('app', { name: 'app', tunnel: 'dead' });
check('app tunnels via dead', r.ok, r.error);
r = await manager.connect('app');
check('unreachable tunnel fails with readable error', !r.ok && /tunnel "dead"/.test(r.error ?? ''), r.error);
check('tunnel client released after failed connect', manager.tunnelClients.size === 0, `left: ${[...manager.tunnelClients.keys()].join(',')}`);

await manager.shutdown();
check('shutdown leaves no tunnel clients', manager.tunnelClients.size === 0);

const failed = results.filter((x) => !x.ok).length;
console.log(failed === 0 ? `ALL ${results.length} PASS` : `${failed}/${results.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
