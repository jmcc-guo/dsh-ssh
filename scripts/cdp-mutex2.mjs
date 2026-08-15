/** CDP: mutex in the new column — transfer to ai, run long command, check input disabled. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9236',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-mutex2',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9236/json').then((r) => r.json());
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
  if (result.result?.exceptionDetails) return 'EXC: ' + (result.result.exceptionDetails.text ?? '');
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// transfer web-srv to ai via host WS (direct driver)
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
await hreq('transferToAi', { name: 'web-srv' });
await hreq('exec', { name: 'web-srv', command: 'sleep 60' });
console.log('busy command started');

// activate session + open column
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return t === 'dsh-ssh' || t.startsWith('dsh-ssh '); }); if (wsRow) wsRow.click(); })()`);
await sleep(1500);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); })()`);
await sleep(2500);
await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
await sleep(2000);

console.log('transfer strip gone (ai source):', await ev(`!document.querySelector('.ssh-transfer-strip')`));
console.log('input disabled:', await ev(`document.querySelector('.ssh-prompt-input')?.disabled`));
console.log('hint:', await ev(`document.querySelector('.ssh-promptline-hint')?.textContent?.trim() ?? null`));
console.log('kill button:', await ev(`[...document.querySelectorAll('.ssh-term-header button')].map((b) => b.textContent)`));
// collapse → rail reappears
console.log('collapse:', await ev(`(() => { const b = document.querySelector('.ssh-collapse'); if (b) { b.click(); return 'clicked'; } return 'no'; })()`));
await sleep(1500);
console.log('rail after collapse:', await ev(`!!document.querySelector('.ssh-rail')`));
ws.close();
host.close();
edge.kill();
process.exit(0);
