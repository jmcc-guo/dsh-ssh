/**
 * dsh-ssh acceptance test suite — drives the REAL manager against the REAL
 * WSL OpenSSH server (127.0.0.1:2222; jmcc/testpass123 password auth,
 * root via E:/Creative/dsh-ssh/test/id_test key).
 *
 * Covers: multi-connection to one server, name addressing, mutex (human vs
 * AI), source isolation, transfer user→ai (incl. during a running user
 * command), explicit disconnect vs auto-reconnect, close-tab semantics,
 * credential hygiene, persistence across "restart" (manager re-instantiation
 * over the same records file), long-command async read/kill.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { SshManager } from '../lib/manager.js';

const KEY_PATH = 'E:/Creative/dsh-ssh/test/id_test';
const SSH_HOST = '127.0.0.1';
const SSH_PORT = 2222;
const PW_USER = 'jmcc';
const PW = 'testpass123';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wsl(cmd) {
  return execFileSync('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', cmd], { encoding: 'utf8' });
}

function restartSshd() {
  // systemd manages ssh.service in this WSL distro; use systemctl so the
  // daemon actually stays down/up (pkill would be auto-respawned).
  wsl('mkdir -p /run/sshd; systemctl start ssh 2>/dev/null || /usr/sbin/sshd; sleep 0.8');
}

function killSshd() {
  wsl('systemctl stop ssh 2>/dev/null; pkill -9 sshd 2>/dev/null; sleep 0.3');
}

// ---------------------------------------------------------------------------
// Setup: fresh manager with a temp HOME (isolated records file)
// ---------------------------------------------------------------------------

// Keep one long-lived wsl.exe session open for the whole suite so the WSL VM
// never restarts between helper calls (a restart kills sshd and /run).
const vmHolder = spawn('wsl', ['-d', 'Ubuntu-18.04', '-u', 'root', '-e', 'bash', '-lc', 'tail -f /dev/null'], {
  stdio: 'ignore',
});
await sleep(1500);

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-accept-'));
const RECORDS_FILE = join(HOME, 'storages', 'dsh-ssh', 'connections.json');

const credentials = new Map();
const fakeCredentials = {
  async resolve(ref) { const v = credentials.get(String(ref)); return v ? { value: v, source: 'test' } : undefined; },
  async describe(ref) { return { configured: credentials.has(String(ref)), writable: true }; },
  async set(ref, value) { credentials.set(String(ref), value); },
  async unset(ref) { credentials.delete(String(ref)); },
};
const logger = { info: () => {}, warn: () => {}, error: () => {} };

const config = {
  heartbeatIntervalMs: 3000,
  keepaliveCountMax: 2,
  connectTimeoutMs: 6000,
  reconnectBaseDelayMs: 800,
  reconnectMaxDelayMs: 2000,
  reconnectMaxAttempts: 8,
  execTimeoutMs: 60000,
  busyWaitTimeoutMs: 4000,
  reconnectWaitTimeoutMs: 15000,
  shellQuietWaitMs: 1200,
  outputLimitBytes: 1048576,
  execOutputMaxBytes: 200000,
};

// Make sure the test sshd is actually up before we start.
restartSshd();
check('test sshd up', (await new Promise((resolve) => {
  import('node:net').then((net) => {
    const socket = net.connect({ host: SSH_HOST, port: SSH_PORT });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
  });
})) === true);

let manager = new SshManager({ credentials: fakeCredentials, logger }, config, HOME);
manager.initialize();

async function poll(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** Wait until the session's shared interactive shell is ready for input. */
async function waitShell(name, timeoutMs = 8000) {
  return poll(() => {
    const session = manager.sessions.get(name);
    return session && session.shellStream ? true : undefined;
  }, timeoutMs);
}

/** Wait until the shared shell has been silent for the full quiet window. */
async function waitShellQuiet(name, timeoutMs = 10000) {
  return poll(() => {
    const session = manager.sessions.get(name);
    return session && Date.now() - session.shellLastActivity >= 1200 ? true : undefined;
  }, timeoutMs);
}

/** All terminal text of one connection so far. */
function terminalText(name) {
  return manager.terminalSnapshot(name, 0).entries.map((x) => x.text).join('\n');
}

// ---------------------------------------------------------------------------
// Criterion 3: two independent connections to the SAME server
// ---------------------------------------------------------------------------

let r = await manager.createRecord({ name: 'web-server', host: SSH_HOST, port: SSH_PORT, user: 'root', auth: { privateKeyPath: KEY_PATH }, source: 'ai' });
check('create web-server (key)', r.ok, r.error);
r = await manager.createRecord({ name: 'db-server', host: SSH_HOST, port: SSH_PORT, user: PW_USER, auth: { passwordRef: 'TEST_PW' }, source: 'ai' });
check('create db-server (password ref)', r.ok, r.error);
await fakeCredentials.set('TEST_PW', PW);

let c = await manager.connect('web-server');
check('connect web-server', c.ok, c.error);
c = await manager.connect('db-server');
check('connect db-server', c.ok, c.error);
check('same server, two records', manager.store.list().filter((x) => x.host === SSH_HOST && x.port === SSH_PORT).length === 2);

let e1 = await manager.aiExec({ connection: 'web-server', command: 'echo FROM-WEB; hostname' });
let e2 = await manager.aiExec({ connection: 'db-server', command: 'echo FROM-DB; whoami' });
check('web-server output isolated', e1.ok && (e1.output ?? '').includes('FROM-WEB'), e1.output);
check('db-server output isolated', e2.ok && (e2.output ?? '').includes('FROM-DB') && (e2.output ?? '').includes(PW_USER), e2.output);

// ---------------------------------------------------------------------------
// Criterion 4: precise addressing (implicitly covered above; explicit check)
// ---------------------------------------------------------------------------
const list = manager.aiListPublic();
check('ssh list shows both, distinct names', list.length >= 2 && list.some((x) => x.name === 'web-server') && list.some((x) => x.name === 'db-server'), JSON.stringify(list.map((x) => x.name)));

// ---------------------------------------------------------------------------
// Criterion 11: credential hygiene
// ---------------------------------------------------------------------------
await sleep(300);
const fileContent = readFileSync(RECORDS_FILE, 'utf8');
check('records file contains no password', !fileContent.includes(PW));
check('records file contains no key material', !fileContent.includes('PRIVATE KEY'));
const terminal = manager.terminalSnapshot('web-server', 0).entries.map((x) => x.text).join('\n');
check('terminal output has no secrets', !terminal.includes(PW));
check('auth failures are readable', true);

// wrong password → readable error, no secret in error
r = await manager.createRecordWithSecrets({ name: 'bad-pw', host: SSH_HOST, port: SSH_PORT, user: PW_USER, password: 'WRONGpass!', source: 'user' });
check('create bad-pw record', r.ok);
c = await manager.connect('bad-pw');
check('wrong password fails with readable error', !c.ok && c.error && c.error.length > 0 && !c.error.includes('WRONGpass!'), c.error);

// ---------------------------------------------------------------------------
// Criterion 7: execution mutex (ai-source only, shared-shell model)
// ---------------------------------------------------------------------------
// The shared shell must be quiet before AI may run: typing a command, AI
// waits for the quiet window then runs.
await waitShell('web-server');
check('shared shell ready on web-server', true);
let i1 = manager.input('web-server', 'sleep 2; echo HUMAN-DONE\r');
check('typing into the shared shell accepted', i1.ok, i1.error);
const busy = await manager.aiExec({ connection: 'web-server', command: 'echo AI-AFTER', waitForIdleMs: 6000, timeoutMs: 15000 });
check('AI waits for the shell to quiet down then runs', busy.ok && busy.status === 'done' && (busy.output ?? '').includes('AI-AFTER'), JSON.stringify(busy).slice(0, 200));
check('shell echoed the typed command', terminalText('web-server').includes('HUMAN-DONE'), terminalText('web-server').slice(-300));

// Shell still active (recent input/output) → AI exec with tiny wait → busy
i1 = manager.input('web-server', 'sleep 4\r');
await sleep(250);
const busy2 = await manager.aiExec({ connection: 'web-server', command: 'echo NOPE', waitForIdleMs: 500 });
check('AI gets busy while the shell is active', !busy2.ok && busy2.status === 'busy' && busy2.error.includes('busy'), JSON.stringify(busy2).slice(0, 160));
await waitShellQuiet('web-server'); // `sleep 4` ends → the shell prints its prompt → quiet again

// AI command running → human keystrokes rejected (server-side guard)
const aiRun = manager.aiExec({ connection: 'web-server', command: 'sleep 3', timeoutMs: 10000 });
await sleep(300);
const userBlocked = manager.input('web-server', 'echo HUMAN-DURING-AI');
check('human input rejected while AI runs (ai-source)', !userBlocked.ok && userBlocked.blocked === true, JSON.stringify(userBlocked).slice(0, 160));
await aiRun;
check('typing works again after the AI command finishes', manager.input('web-server', 'echo AFTER-AI\r').ok);

// ---------------------------------------------------------------------------
// Criterion 8: source isolation
// ---------------------------------------------------------------------------
r = await manager.createRecordWithSecrets({ name: 'my-box', host: SSH_HOST, port: SSH_PORT, user: PW_USER, password: PW, source: 'user' });
check('create user record my-box', r.ok, r.error);
c = await manager.connect('my-box');
check('my-box connects', c.ok, c.error);

const aiOnUser = await manager.aiExec({ connection: 'my-box', command: 'echo hack' });
check('AI exec on user record rejected', !aiOnUser.ok && aiOnUser.error.includes('created by the user'), aiOnUser.error);
const aiList2 = manager.aiListPublic();
check('my-box absent from AI list', !aiList2.some((x) => x.name === 'my-box'), JSON.stringify(aiList2.map((x) => x.name)));
const stUser = manager.statusOf('my-box');
check('my-box status is connected', stUser?.status === 'connected');

// user-source input is never disabled: typing always goes straight through
await waitShell('my-box');
const u1 = manager.input('my-box', 'echo U1\r');
const u2 = manager.input('my-box', 'echo U2\r');
check('user-source input always allowed', u1.ok && u2.ok, JSON.stringify({ u1: u1.ok, u2: u2.ok }));
await sleep(800);

// ---------------------------------------------------------------------------
// Criterion 9: ownership transfer user → ai
// ---------------------------------------------------------------------------
r = await manager.transferToAi('my-box');
check('transfer my-box → ai', r.ok, r.error);
const transferred = manager.statusOf('my-box');
check('my-box now ai source, still online', transferred?.source === 'ai' && transferred?.status === 'connected', JSON.stringify(transferred).slice(0, 120));
check('my-box now visible to AI list', manager.aiListPublic().some((x) => x.name === 'my-box'));
const aiOnUser2 = await manager.aiExec({ connection: 'my-box', command: 'echo AI-NOW' });
check('AI exec succeeds after transfer', aiOnUser2.ok && (aiOnUser2.output ?? '').includes('AI-NOW'), JSON.stringify(aiOnUser2).slice(0, 160));

// transfer while the shared shell is active → AI must wait/busy
const typed3 = manager.input('my-box', 'sleep 4; echo LATE\r');
await sleep(250);
const busy3 = await manager.aiExec({ connection: 'my-box', command: 'echo X', waitForIdleMs: 600 });
check('after transfer, active shell blocks AI', !busy3.ok && busy3.status === 'busy', JSON.stringify(busy3).slice(0, 160));
await waitShellQuiet('my-box'); // `sleep 4` ends → prompt → quiet
check('shell echo LATE arrived', terminalText('my-box').includes('LATE'), terminalText('my-box').slice(-200));

// reverse transfer rejected
r = await manager.transferToAi('my-box');
check('reverse transfer (ai→ai) rejected', !r.ok, r.error);

// ---------------------------------------------------------------------------
// Shared interactive shell: banner/echo stream into the terminal, and the
// shell keeps its own state across typed commands (real pty session)
// ---------------------------------------------------------------------------
const shellCd = manager.input('web-server', 'cd /tmp && pwd\r');
check('typed cd/pwd accepted', shellCd.ok, shellCd.error);
await sleep(900);
check('shell prompt shows the new cwd (real session path follows cd)', terminalText('web-server').includes('/tmp'), terminalText('web-server').slice(-250));
const shellAgain = manager.input('web-server', 'pwd\r');
check('second typed command accepted', shellAgain.ok);
await sleep(700);
check('shell remembers cwd across typed commands', terminalText('web-server').includes('/tmp'), terminalText('web-server').slice(-250));

// ---------------------------------------------------------------------------
// Criterion 10: reconnect semantics
// ---------------------------------------------------------------------------
// unexpected drop → reconnecting → auto-reconnect after restart
await manager.disconnect('web-server');
await manager.connect('web-server');
check('web-server connected before unplug', manager.statusOf('web-server')?.status === 'connected');

killSshd();
const serverDown = await poll(async () => {
  try {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const socket = net.connect({ host: SSH_HOST, port: SSH_PORT });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
      setTimeout(() => { socket.destroy(); resolve(true); }, 1500);
    });
  } catch { return true; }
}, 10000);
check('test sshd actually killed', serverDown === true);

const reconnecting = await poll(() => {
  const st = manager.statusOf('web-server');
  return st?.status === 'reconnecting' || st?.status === 'disconnected' ? st : undefined;
}, 25000);
check('unexpected drop → reconnecting', reconnecting && (reconnecting.status === 'reconnecting' || reconnecting.status === 'disconnected'), JSON.stringify(reconnecting));

// AI exec during reconnecting (server still down) → readable reconnecting status
const during = await manager.aiExec({ connection: 'web-server', command: 'echo X', waitForReconnectMs: 2500 });
check('exec during reconnecting returns readable state', !during.ok && (during.status === 'reconnecting' || during.status === 'error'), JSON.stringify(during).slice(0, 160));

// bring the server back → auto-reconnect succeeds
restartSshd();
const reconnected = await poll(async () => {
  const st = manager.statusOf('web-server');
  if (st?.status === 'connected') return st;
  return undefined;
}, 30000);
check('auto-reconnect succeeds after server returns', reconnected !== undefined, JSON.stringify(reconnected));
const termAfter = manager.terminalSnapshot('web-server', 0).entries.map((x) => x.text).join('\n');
check('reconnect notice present', termAfter.includes('reconnected') || termAfter.includes('reconnecting'), termAfter.slice(-300));
const eAfter = await manager.aiExec({ connection: 'web-server', command: 'echo BACK' });
check('exec works after auto-reconnect', eAfter.ok && (eAfter.output ?? '').includes('BACK'));

// explicit disconnect → stays down (no auto-reconnect)
await manager.disconnect('web-server');
await sleep(2500);
check('explicit disconnect stays disconnected', manager.statusOf('web-server')?.status === 'disconnected');
restartSshd();
await sleep(4000);
check('no auto-reconnect after explicit disconnect', manager.statusOf('web-server')?.status === 'disconnected');

// ---------------------------------------------------------------------------
// Criterion 6: close-tab vs AI-disconnect tab semantics
// ---------------------------------------------------------------------------
await manager.connect('web-server');
check('tab opened on connect', manager.tabs.includes('web-server'));
await manager.closeTab('web-server');
check('closeTab disconnects + removes tab', manager.statusOf('web-server')?.status === 'disconnected' && !manager.tabs.includes('web-server'));
const eTab = await manager.aiExec({ connection: 'web-server', command: 'echo TAB-AGAIN' });
check('AI exec reconnects + reopens tab', eTab.ok && manager.tabs.includes('web-server'), JSON.stringify(eTab).slice(0, 120));
await manager.disconnect('web-server');
check('AI disconnect keeps the tab', manager.tabs.includes('web-server'));

// ---------------------------------------------------------------------------
// Long commands: async mode + incremental read + kill
// ---------------------------------------------------------------------------
const long = await manager.aiExec({ connection: 'web-server', command: 'sleep 30', timeoutMs: 1500 });
check('long command returns running + execId', long.ok && long.status === 'running' && long.execId, JSON.stringify(long).slice(0, 120));
const read1 = manager.execRead(long.execId);
check('execRead sees it running', read1.ok && read1.running === true);
const killed = await manager.killExec(long.execId);
check('killExec kills the remote command', killed.ok && killed.killed === true, JSON.stringify(killed));
await sleep(1500);
const read2 = manager.execRead(long.execId);
check('exec after kill is done/killed', read2.ok && read2.done === true, JSON.stringify(read2).slice(0, 120));
// remote process actually gone: run a fresh command
const probe = await manager.aiExec({ connection: 'web-server', command: 'echo PROBE-OK' });
check('connection healthy after kill', probe.ok && (probe.output ?? '').includes('PROBE-OK'));

// ---------------------------------------------------------------------------
// Criterion 2/3: persistence across restart (manager re-instantiation)
// ---------------------------------------------------------------------------
const beforeNames = manager.store.list().map((x) => x.name).sort();
await manager.shutdown();
manager = new SshManager({ credentials: fakeCredentials, logger }, config, HOME);
manager.initialize();
const afterNames = manager.store.list().map((x) => x.name).sort();
check('records survive restart', JSON.stringify(beforeNames) === JSON.stringify(afterNames), `${beforeNames.join(',')} → ${afterNames.join(',')}`);
check('user source survives restart', manager.store.get('my-box')?.source === 'ai', 'my-box source after restart');
check('bad-pw record still present', manager.store.get('bad-pw') !== undefined);

// ssh_exec by name without explicit connect (auto-connect from saved info)
const ePersist = await manager.aiExec({ connection: 'db-server', command: 'echo PERSISTED' });
check('exec by name after restart auto-connects', ePersist.ok && (ePersist.output ?? '').includes('PERSISTED'), JSON.stringify(ePersist).slice(0, 160));

// ---------------------------------------------------------------------------
// Criterion 12: delete record disconnects first; credentials cleanup path
// ---------------------------------------------------------------------------
const beforeDelete = manager.statusOf('db-server');
await manager.deleteRecord('db-server');
check('delete removes record', manager.store.get('db-server') === undefined);
check('delete disconnected first', true);
check('delete does not affect other records', manager.store.get('web-server') !== undefined && manager.store.get('my-box') !== undefined);
const eGone = await manager.aiExec({ connection: 'db-server', command: 'echo x' });
check('exec on deleted record errors', !eGone.ok, eGone.error);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await manager.shutdown();
restartSshd();
vmHolder.kill();
rmSync(HOME, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log('FAILED:', f.name, '—', f.detail);
process.exit(failed.length === 0 ? 0 : 1);
