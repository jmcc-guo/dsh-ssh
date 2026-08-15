/**
 * CDP live-terminal verification: drive the real browser against 127.0.0.1:3081
 * and capture the DGX-style live terminal — login banner (motd / Last login),
 * remote prompt `user@host:path$`, input echo, cd path updates, no input box,
 * no copy button. Also types through the invisible key catcher via CDP Input.
 */
import { spawn, execSync } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-ssh-edge-live-'));
const DBG_PORT = 9500 + Math.floor(Math.random() * 500);
const OUT_DIR = 'E:/Creative/dsh-ssh/test/shots';

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG_PORT}`,
  `--user-data-dir=${DATA_DIR}`,
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const killEdge = () => {
  try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
};

// ---- panel WS ----
const host = new WebSocket('ws://127.0.0.1:3081/ssh/ws');
let hid = 0;
const hpending = new Map();
const hreq = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++hid;
  hpending.set(callId, { resolve, reject });
  host.send(JSON.stringify({ id: callId, method, params }));
});
host.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.id !== undefined && m.id !== null) {
    const entry = hpending.get(m.id);
    if (entry) {
      hpending.delete(m.id);
      m.error !== undefined ? entry.reject(new Error(m.error)) : entry.resolve(m.result);
    }
  }
});
await new Promise((resolve) => host.on('open', resolve));

const NAME = 'preview-box';
try { await hreq('deleteRecord', { name: NAME }).catch(() => {}); } catch { /* ignore */ }
await hreq('createRecord', { name: NAME, host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
const con = await hreq('connect', { name: NAME });
console.log('connect:', JSON.stringify(con).slice(0, 120));

// Wait until the shell has printed its prompt (startup termios flushes input
// typed too early).
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const snap = await hreq('terminalSnapshot', { name: NAME, since: 0 }).catch(() => null);
  const text = (snap?.entries ?? []).map((e) => e.text).join('');
  if (/\$ |# $|➜/.test(text) && text.includes('\u001b]0;')) break;
}

// Type commands into the shared shell ONE CHARACTER PER WRITE, exactly like
// the real DGX shell echo pattern (each keystroke arrives as its own chunk).
const typeChars = async (text) => {
  for (const ch of text) {
    const r = await hreq('input', { name: NAME, data: ch });
    if (r && r.error && !r.ok) throw new Error(r.error);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await hreq('input', { name: NAME, data: '\r' });
  await sleep(800);
};
await typeChars('cd apps 2>/dev/null; mkdir -p apps && cd apps && pwd');
await typeChars('ls');
await typeChars('whoami; echo "welcome to the live terminal"');

// ---- browser CDP ----
await new Promise((resolve) => setTimeout(resolve, 6000));
const targets = await fetch(`http://127.0.0.1:${DBG_PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('3081'));
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const cid = ++id;
  pending.set(cid, resolve);
  ws.send(JSON.stringify({ id: cid, method, params }));
});
ws.on('message', (data) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve) => ws.on('open', resolve));
await send('Runtime.enable');
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.result?.exceptionDetails) return 'EXC: ' + (result.result.exceptionDetails.text ?? '');
  return result.result?.result?.value;
};

// Open the chat workspace + session (rail auto-opens the panel on new tabs).
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
// Open a real (non-blank) chat session — the details column only renders
// while a non-blank session is current.
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; const row = rows.find((el) => { const t = (el.textContent || '').trim(); return t && !/新会话|New session/i.test(t); }) ?? rows[0]; if (row) row.click(); })()`);
await sleep(3000);
for (let attempt = 0; attempt < 4; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  if ((await ev(`!!document.querySelector('.ssh-panel')`)) === true) break;
}

const panel = await ev(`!!document.querySelector('.ssh-panel')`);
const inputBox = await ev(`!!document.querySelector('.ssh-prompt-input')`);
const copyBtn = await ev(`!!document.querySelector('.ssh-terminal-tools')`);
const text = await ev(`(() => { const s = document.querySelector('.ssh-terminal-scroll'); return s ? s.innerText : ''; })()`);
console.log('panel open:', panel, '| legacy input box present:', inputBox, '| copy control present:', copyBtn);
console.log('---- terminal text ----');
console.log(text.slice(0, 1200));
console.log('------------------------');

// Type a partial command through the invisible catcher (real keystrokes).
await ev(`(() => { const i = document.querySelector('.ssh-terminal-catcher'); if (i) i.focus(); return !!i; })()`);
await send('Input.insertText', { text: 'echo typed-live' });
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(1200);

const after = await ev(`(() => { const s = document.querySelector('.ssh-terminal-scroll'); return s ? s.innerText : ''; })()`);
console.log('typed-live echoed:', after.includes('typed-live'));
console.log('---- tail after typing ----');
console.log(after.slice(-700));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT_DIR, 'live-terminal.png'), Buffer.from(shot.result.data, 'base64'));
console.log('screenshot saved: test/shots/live-terminal.png');

await hreq('deleteRecord', { name: NAME }).catch(() => {});
ws.close();
host.close();
killEdge();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
