/** Probe the panel's DOM presence + geometry in the real browser. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-ssh-edge-geo-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9265',
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

const NAME = 'geo-box';
try { await hreq('deleteRecord', { name: NAME }).catch(() => {}); } catch { /* ignore */ }
await hreq('createRecord', { name: NAME, host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
await hreq('connect', { name: NAME });

await new Promise((resolve) => setTimeout(resolve, 5000));
const targets = await fetch('http://127.0.0.1:9265/json').then((r) => r.json());
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
  if (result.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(result.result.exceptionDetails).slice(0, 200);
  return result.result?.result?.value;
};

await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; const row = rows.find((el) => { const t = (el.textContent || '').trim(); return t && !/新会话|New session/i.test(t); }) ?? rows[0]; if (row) row.click(); })()`);
await sleep(3500);
for (let attempt = 0; attempt < 5; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  if ((await ev(`!!document.querySelector('.ssh-panel')`)) === true) break;
}
await sleep(1500);

console.log('panel in DOM:', await ev(`!!document.querySelector('.ssh-panel')`));
console.log('panel rect:', await ev(`(() => { const el = document.querySelector('.ssh-panel'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility}); })()`));
console.log('rail rect:', await ev(`(() => { const el = document.querySelector('.ssh-rail'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`));
console.log('scroll rect:', await ev(`(() => { const el = document.querySelector('.ssh-terminal-scroll'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`));
console.log('details slot nodes:', await ev(`(() => { const all = [...document.querySelectorAll('[class*="details" i]')]; return JSON.stringify(all.slice(0,8).map((el) => ({ cls: el.className, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))); })()`));
console.log('panelOpen via store not accessible; rail hidden?', await ev(`(() => { const r = document.querySelector('.ssh-rail'); return r ? getComputedStyle(r).display : 'no-rail'; })()`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('E:/Creative/dsh-ssh/test/shots/geo-probe.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot saved');

await hreq('deleteRecord', { name: NAME }).catch(() => {});
ws.close();
host.close();
edge.kill();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
