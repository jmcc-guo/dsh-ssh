/** Instrumented runCommand probe. */
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

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-instr-'));
const creds = new Map();
const manager = new SshManager({
  credentials: { resolve: async (ref) => { const v = creds.get(String(ref)); return v ? { value: v } : undefined; }, set: async (r, v) => creds.set(String(r), v), unset: async () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}, { heartbeatIntervalMs: 3000, keepaliveCountMax: 2, connectTimeoutMs: 5000 }, HOME);
manager.initialize();
await manager.createRecord({ name: 't', host: '127.0.0.1', port: 2222, user: 'root', auth: { privateKeyPath: 'E:/Creative/dsh-ssh/test/id_test' }, source: 'ai' });

// instrument runCommand
const origRun = manager.runCommand.bind(manager);
manager.runCommand = async (session, opts) => {
  const t0 = Date.now();
  const result = await origRun(session, opts);
  const cmd = result.cmd;
  console.log(`[runCommand] ${cmd.command} → ${result.ok ? 'ok' : result.error} at +${Date.now() - t0}ms, done=${cmd.done}, exitCode=${cmd.exitCode}, killed=${cmd.killed}, error=${cmd.error}`);
  // attach extra listeners to see raw stream events
  if (cmd.stream) {
    cmd.stream.on('close', (code, signal, core, desc) => console.log(`  [stream close] code=${code} signal=${signal} at +${Date.now() - t0}ms`));
  }
  return result;
};

await manager.connect('t');
console.log('connected');
const t0 = Date.now();
const r = await manager.aiExec({ connection: 't', command: 'sleep 8', timeoutMs: 3000 });
console.log(`aiExec returned at +${Date.now() - t0}ms:`, JSON.stringify(r).slice(0, 200));
const t1 = Date.now();
const r2 = await manager.aiExec({ connection: 't', command: 'sleep 8', timeoutMs: 3000 });
console.log(`aiExec#2 returned at +${Date.now() - t1}ms:`, JSON.stringify(r2).slice(0, 200));
console.log('terminal entries:');
for (const e of manager.terminalSnapshot('t', 0).entries) console.log(`  [${e.kind}] ${e.text}`);
await manager.shutdown();
holder.kill();
process.exit(0);
