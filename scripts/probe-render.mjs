/**
 * Browser-side renderer probe: type ONE command into the live terminal and
 * dump the exact rendered DOM lines (escaped) to isolate the line-assembly.
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-ssh-edge-probe-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9260',
  `--user-data-dir=${DATA_DIR}`,
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const NAME = 'probe2-box';
try { await hreq('deleteRecord', { name: NAME }).catch(() => {}); } catch { /* ignore */ }
await hreq('createRecord', { name: NAME, host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
await hreq('connect', { name: NAME });
await sleep(2500);
// type BEFORE the panel opens (as in the real flow)
await hreq('input', { name: NAME, data: 'echo one-two-three\r' });
await sleep(1000);

// ---- open the panel ----
await new Promise((resolve) => setTimeout(resolve, 4000));
const targets = await fetch('http://127.0.0.1:9260/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('3081'));
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
  if (result.result?.exceptionDetails) return 'EXC';
  return result.result?.result?.value;
};
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); })()`);
await sleep(3000);
for (let attempt = 0; attempt < 4; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  if ((await ev(`!!document.querySelector('.ssh-panel')`)) === true) break;
}
await sleep(1500);

const dump = await ev(`(() => [...document.querySelectorAll('.ssh-terminal-scroll .ssh-line')].map((el) => JSON.stringify(el.innerText)).join('\\n'))()`);
console.log('=== RENDERED LINES (escaped) ===');
console.log(dump);

await hreq('deleteRecord', { name: NAME }).catch(() => {});
ws.close();
host.close();
edge.kill();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
