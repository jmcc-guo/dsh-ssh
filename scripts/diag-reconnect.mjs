/** Focused reconnect diagnostics. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshManager } from '../lib/manager.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wsl(cmd) { return execFileSync('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', cmd], { encoding: 'utf8' }); }
function probe() {
  return new Promise((resolve) => {
    import('node:net').then((net) => {
      const s = net.connect({ host: '127.0.0.1', port: 2222 });
      s.once('connect', () => { s.destroy(); resolve('UP'); });
      s.once('error', () => resolve('DOWN'));
      setTimeout(() => { s.destroy(); resolve('DOWN?'); }, 1200);
    });
  });
}

const holder = spawn('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', 'tail -f /dev/null'], { stdio: 'ignore' });
await sleep(1200);
wsl('mkdir -p /run/sshd; pkill -9 sshd 2>/dev/null; sleep 0.4; /usr/sbin/sshd; sleep 0.8');
console.log('sshd restarted, probe:', await probe());

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-diag-'));
const creds = new Map();
const manager = new SshManager({
  credentials: {
    resolve: async (ref) => { const v = creds.get(String(ref)); return v ? { value: v } : undefined; },
    set: async (ref, v) => creds.set(String(ref), v), unset: async (ref) => creds.delete(String(ref)),
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}, { heartbeatIntervalMs: 2000, keepaliveCountMax: 1, reconnectBaseDelayMs: 700, reconnectMaxDelayMs: 1500, reconnectMaxAttempts: 8, connectTimeoutMs: 5000 }, HOME);
manager.initialize();
await manager.createRecord({ name: 'diag', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: 'E:/Creative/dsh-ssh/test/id_test' }, source: 'ai' });
await manager.connect('diag');
console.log('connected:', manager.statusOf('diag')?.status);

console.log('--- killing sshd ---');
wsl('pkill -9 sshd 2>/dev/null');
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  const st = manager.statusOf('diag');
  console.log(`t+${i + 1}s status=${st?.status} attempts=${st?.reconnectAttempts} err=${st?.lastError} | port=${await probe()}`);
  if (i === 3) {
    const r = await manager.aiExec({ connection: 'diag', command: 'echo DURING', waitForReconnectMs: 3000, timeoutMs: 5000 });
    console.log('during aiExec:', JSON.stringify(r).slice(0, 180));
  }
}
console.log('--- restarting sshd ---');
wsl('mkdir -p /run/sshd; /usr/sbin/sshd; sleep 0.5');
for (let i = 0; i < 8; i++) {
  await sleep(1000);
  const st = manager.statusOf('diag');
  console.log(`t+${i + 1}s status=${st?.status} attempts=${st?.reconnectAttempts} | port=${await probe()}`);
  if (st?.status === 'connected') break;
}
const after = await manager.aiExec({ connection: 'diag', command: 'echo AFTER-OK', timeoutMs: 8000 });
console.log('after aiExec:', JSON.stringify(after).slice(0, 200));
console.log('terminal tail:', manager.terminalSnapshot('diag', 0).entries.slice(-6).map((e) => `[${e.kind}/${e.source}] ${e.text}`).join('\n'));
await manager.shutdown();
holder.kill();
process.exit(0);
