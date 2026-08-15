/**
 * Quick smoke test for the dsh-ssh manager against the WSL test SSH server.
 * Exercises password auth, key auth, exec, list, disconnect.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-smoke-'));

const credentials = new Map();
const fakeCredentials = {
  async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
  async describe(ref) { return { configured: credentials.has(String(ref)), writable: true }; },
  async set(ref, value) { credentials.set(String(ref), value); },
  async unset(ref) { credentials.delete(String(ref)); },
};
const logger = { info: (...a) => console.log('INFO', ...a), warn: (...a) => console.log('WARN', ...a), error: (...a) => console.log('ERROR', ...a) };

const manager = new SshManager({ credentials: fakeCredentials, logger }, { heartbeatIntervalMs: 3000, reconnectBaseDelayMs: 1000 }, HOME);
manager.initialize();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. password auth (user-source; shared-shell input path)
let r = await manager.createRecordWithSecrets({ name: 'box-pw', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123', source: 'user' });
check('create password record', r.ok, r.error);
let c = await manager.connect('box-pw');
check('connect with password', c.ok, c.error);
await new Promise((res) => setTimeout(res, 800));
const shellReady = manager.sessions.get('box-pw')?.shellStream != null;
check('shared shell spawned', shellReady === true);
const typed = manager.input('box-pw', 'echo hello; whoami\r');
check('typing into the shell accepted', typed.ok, typed.error);
await new Promise((res) => setTimeout(res, 1500));
const text = manager.terminalSnapshot('box-pw', 0).entries.map((x) => x.text).join('\n');
check('shell echo + output visible', text.includes('hello') && text.includes('jmcc'), text.slice(-200));
let s1 = manager.statusOf('box-pw');
check('no busy state on idle shell', s1.busyBy === null, JSON.stringify(s1.busyBy));

// 2. key auth (ai-source; AI exec path)
r = await manager.createRecord({ name: 'box-key', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: 'E:/Creative/dsh-ssh/test/id_test' }, source: 'ai' });
check('create key record', r.ok, r.error);
c = await manager.connect('box-key');
check('connect with key', c.ok, c.error);
let e = await manager.aiExec({ connection: 'box-key', command: 'whoami && hostname' });
check('exec as root', e.ok && e.status === 'done' && e.exitCode === 0 && (e.output ?? '').includes('root'), JSON.stringify(e).slice(0, 200));

// 3. duplicate name rejection
r = await manager.createRecordWithSecrets({ name: 'box-pw', host: 'x', user: 'y', password: 'z', source: 'user' });
check('duplicate name rejected', !r.ok && r.error.includes('already taken'), r.error);

// 4. inline secret rejection
r = await manager.createRecord({ name: 'box-bad', host: '127.0.0.1', user: 'jmcc', auth: { type: 'password', password: 'testpass123' }, source: 'ai' });
check('inline secret rejected', !r.ok, r.error);

// 5. list/status
const list = await manager.aiListPublic();
check('list contains ai records only', Array.isArray(list) && list.every((x) => x.source === 'ai') && list.some((x) => x.name === 'box-key'), JSON.stringify(list.map((x) => x.name)));
const st = manager.statusOf('box-key');
check('status connected', st?.status === 'connected', JSON.stringify(st));

// 6. disconnect + no reconnect on explicit
await manager.disconnect('box-key');
await new Promise((res) => setTimeout(res, 3500));
const st2 = manager.statusOf('box-key');
check('explicit disconnect stays down', st2?.status === 'disconnected', JSON.stringify(st2));

await manager.shutdown();
const failed = results.filter((r2) => !r2.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
