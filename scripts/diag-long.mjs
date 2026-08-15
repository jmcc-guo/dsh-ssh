/** Long-command probe: does exec close early after a disconnect/reconnect? */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wsl(cmd) { return execFileSync('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', cmd], { encoding: 'utf8' }); }
const holder = spawn('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', 'tail -f /dev/null'], { stdio: 'ignore' });
await sleep(1000);
wsl('mkdir -p /run/sshd; systemctl start ssh 2>/dev/null || /usr/sbin/sshd; sleep 0.5');

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-long-'));
const creds = new Map();
const manager = new SshManager({
  credentials: { resolve: async (ref) => { const v = creds.get(String(ref)); return v ? { value: v } : undefined; }, set: async (r, v) => creds.set(String(r), v), unset: async () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}, { heartbeatIntervalMs: 3000, keepaliveCountMax: 2, connectTimeoutMs: 5000 }, HOME);
manager.initialize();
await manager.createRecord({ name: 't', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: 'E:/Creative/dsh-ssh/test/id_test' }, source: 'ai' });

// Case A: fresh connect, long command
await manager.connect('t');
let r = await manager.aiExec({ connection: 't', command: 'sleep 20', timeoutMs: 1500 });
console.log('A fresh-connect sleep20:', JSON.stringify(r).slice(0, 160));
let rr = await manager.aiExec({ connection: 't', command: 'echo A-OK', timeoutMs: 5000 });
console.log('A2 echo:', JSON.stringify(rr).slice(0, 160));
await sleep(19000);
console.log('A2 after sleep20 ended, execRead of', r.execId, ':', JSON.stringify(manager.execRead(r.execId)).slice(0, 140));

// Case B: after disconnect, long command
await manager.disconnect('t');
r = await manager.aiExec({ connection: 't', command: 'sleep 20', timeoutMs: 1500 });
console.log('B after-disconnect sleep20:', JSON.stringify(r).slice(0, 160));
rr = await manager.aiExec({ connection: 't', command: 'echo B-OK', timeoutMs: 5000 });
console.log('B2 echo:', JSON.stringify(rr).slice(0, 160));

await manager.shutdown();
holder.kill();
process.exit(0);
