/**
 * End-to-end SSH-tunnel test — drives the REAL manager against the REAL
 * local OpenSSH server (127.0.0.1:2222; root via test/id_test). Requires the
 * same reachable SSH server as scripts/smoke.mjs.
 *
 * The target connection routes through the jump host via an ssh2
 * `forwardOut` direct-tcpip channel, verifies exec + shared shell through
 * the tunnel, shared/refcounted tunnel clients for parallel tabs, and
 * release on disconnect.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SshManager } from '../lib/manager.js';

const KEY_PATH = fileURLToPath(new URL('../test/id_test', import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-tunnel-e2e-'));

const credentials = new Map();
const fakeCredentials = {
  async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
  async set(ref, value) { credentials.set(String(ref), value); },
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const manager = new SshManager(
  { credentials: fakeCredentials, logger },
  { connectTimeoutMs: 6000, heartbeatIntervalMs: 3000 },
  HOME,
);
manager.initialize();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Jump host and target point at the same local server; the target rides the
// tunnel (dst 127.0.0.1:2222 is resolved from the jump host's side).
let r = await manager.createRecord({ name: 'gw', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: KEY_PATH }, source: 'ai' });
check('create gw record', r.ok, r.error);
r = await manager.createRecord({ name: 'target', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: KEY_PATH }, tunnel: 'gw', source: 'ai' });
check('create tunneled target record', r.ok, r.error);

let c = await manager.connect('target');
check('tunneled connect ok', c.ok, c.error);
check('tunnel client cached', manager.tunnelClients.get('gw') !== undefined, c.error);
await sleep(800);
check('shared shell spawned via tunnel', manager.sessions.get('target')?.shellStream != null);

let e = await manager.aiExec({ connection: 'target', command: 'whoami; hostname' });
check('exec through tunnel', e.ok && e.status === 'done' && e.exitCode === 0 && (e.output ?? '').includes('root'), JSON.stringify(e).slice(0, 200));

// A second tunneled tab shares the same tunnel client (refcounted).
const s2 = await manager.openNewSession('target');
check('second tunneled tab ok', s2.ok, s2.error);
check('tunnel client shared', manager.tunnelClients.get('gw')?.sessions.size === 2,
  JSON.stringify([...(manager.tunnelClients.get('gw')?.sessions ?? [])]));

// Disconnect both sessions → the tunnel client is released.
await manager.disconnect('target');
await manager.disconnectKey(s2.key, { closeTab: true });
check('tunnel client released after disconnects', manager.tunnelClients.size === 0,
  `left: ${[...manager.tunnelClients.keys()].join(',')}`);

await manager.shutdown();
check('shutdown leaves no tunnel clients', manager.tunnelClients.size === 0);

const failed = results.filter((x) => !x.ok).length;
console.log(failed === 0 ? `ALL ${results.length} PASS` : `${failed}/${results.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
