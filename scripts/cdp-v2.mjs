/** CDP v2: robust session activation + full column verification. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9239',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-v2',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9239/json').then((r) => r.json());
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// create a test connection via the host WS (WSL test server) so the panel has a tab
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
const created = await hreq('createRecord', { name: 'verify-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
console.log('create verify-box:', created.ok);
await hreq('exec', { name: 'verify-box', command: 'echo READY; cd /tmp; pwd' });
await new Promise((resolve) => setTimeout(resolve, 1500));

// activate workspace + session (robust: try several selectors)
const wsClicked = await ev(`(() => {
  const rows = [...document.querySelectorAll('[class*="Row" i], li, [class*="workspace" i]')];
  const candidates = rows.filter((el) => {
    const t = (el.textContent || '').trim();
    return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t);
  });
  if (candidates.length === 0) return 'no workspace rows';
  candidates[0].click();
  return 'clicked ' + (candidates[0].textContent || '').trim();
})()`);
console.log('workspace:', wsClicked);
await sleep(2000);
const sessionClicked = await ev(`(() => {
  const rows = [...document.querySelectorAll('[class*="sessionRow" i]')];
  if (rows.length === 0) return 'no session rows';
  rows[0].click();
  return 'clicked ' + (rows[0].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
})()`);
console.log('session:', sessionClicked);
await sleep(3500);
console.log('composer:', await ev(`!!document.querySelector('[class*="composer" i]')`));
console.log('frame details-collapsed:', await ev(`(() => { const f = document.querySelector('[data-details-collapsed]'); return f ? f.getAttribute('data-details-collapsed') : 'none'; })()`));

// open the SSH column
await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
await sleep(2500);
console.log('column rect:', await ev(`(() => { const el = document.querySelector('.ssh-panel'); return el ? JSON.stringify({ left: Math.round(el.getBoundingClientRect().left), width: Math.round(el.getBoundingClientRect().width) }) : 'none'; })()`));
console.log('composer right:', await ev(`(() => { const el = document.querySelector('[class*="composer" i]'); return el ? Math.round(el.getBoundingClientRect().right) : 'none'; })()`));
console.log('tabs:', await ev(`[...document.querySelectorAll('.ssh-tab-name')].map((e) => e.textContent)`));
console.log('prompt str:', await ev(`document.querySelector('.ssh-prompt-str')?.textContent ?? null`));
console.log('prompt in dark area:', await ev(`(() => { const w = document.querySelector('.ssh-terminal-wrap2'); const p = document.querySelector('.ssh-promptline'); return w && p ? w.contains(p) : false; })()`));
console.log('cursor:', await ev(`!!document.querySelector('.ssh-prompt-cursor')`));
console.log('transfer strip:', await ev(`!!document.querySelector('.ssh-transfer-strip')`));
console.log('terminal text:', await ev(`(() => { const el = document.querySelector('.ssh-terminal-scroll'); return el ? el.textContent.slice(0, 140) : 'none'; })()`));

// "+" menu
await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) b.click(); })()`);
await sleep(600);
console.log('menu items:', await ev(`[...document.querySelectorAll('.ssh-tabmenu-item')].map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60))`));
await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) b.click(); })()`);
await sleep(300);

// collapse → native restored
await ev(`(() => { const b = document.querySelector('.ssh-collapse'); if (b) b.click(); })()`);
await sleep(2000);
console.log('after collapse rail:', await ev(`!!document.querySelector('.ssh-rail')`));
console.log('after collapse panel:', await ev(`!!document.querySelector('.ssh-panel')`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:/Creative/dsh-ssh/test/shots/v2-column.png', Buffer.from(shot.result.data, 'base64'));
// cleanup test record
await hreq('deleteRecord', { name: 'verify-box' });
console.log('verify-box cleaned');
ws.close();
host.close();
edge.kill();
process.exit(0);
