/** CDP: verify native details restored when panel closed, column when open, + menu, prompt inside terminal. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9238',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-v1',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9238/json').then((r) => r.json());
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

// activate workspace + session
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return t === 'dsh-ssh' || t.startsWith('dsh-ssh '); }); if (wsRow) wsRow.click(); })()`);
await sleep(1500);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); })()`);
await sleep(3000);

// 1. native details column: click a tool call in the conversation → native panel should appear
console.log('native details before (closed):', await ev(`(() => { const f = document.querySelector('[data-details-collapsed]'); return f ? f.getAttribute('data-details-collapsed') : 'no frame'; })()`));

// open the SSH panel via the rail
await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
await sleep(2500);
console.log('column open:', await ev(`(() => { const el = document.querySelector('.ssh-panel'); return el ? JSON.stringify({ left: Math.round(el.getBoundingClientRect().left), width: Math.round(el.getBoundingClientRect().width) }) : 'none'; })()`));
console.log('prompt str:', await ev(`document.querySelector('.ssh-prompt-str')?.textContent ?? null`));
console.log('prompt input present:', await ev(`!!document.querySelector('.ssh-prompt-input')`));
console.log('prompt inside dark area:', await ev(`(() => { const wrap = document.querySelector('.ssh-terminal-wrap2'); const p = document.querySelector('.ssh-promptline'); return wrap && p ? wrap.contains(p) : false; })()`));
console.log('cursor block:', await ev(`!!document.querySelector('.ssh-prompt-cursor')`));
console.log('add button:', await ev(`!!document.querySelector('.ssh-tab-add')`));

// 2. "+" menu: click it, verify saved connections + manual entry
console.log('click add:', await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) { b.click(); return 'clicked'; } return 'no'; })()`));
await sleep(600);
console.log('menu items:', await ev(`[...document.querySelectorAll('.ssh-tabmenu-item')].map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60))`));
console.log('menu title:', await ev(`document.querySelector('.ssh-tabmenu-title')?.textContent ?? null`));

// close the menu, then close the panel → native details should be back in the slot
await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) b.click(); })()`);
await sleep(300);
await ev(`(() => { const b = document.querySelector('.ssh-collapse'); if (b) b.click(); })()`);
await sleep(2000);
console.log('after collapse — rail:', await ev(`!!document.querySelector('.ssh-rail')`));
console.log('after collapse — panel:', await ev(`!!document.querySelector('.ssh-panel')`));
console.log('details collapsed attr:', await ev(`(() => { const f = document.querySelector('[data-details-collapsed]'); return f ? f.getAttribute('data-details-collapsed') : 'no frame'; })()`));
// the native DetailsPanel occupant should be active again: it renders when the column is opened natively
// probe the slot registry through the DOM: the native panel has its own classes; check via ui-layout internals is hard —
// instead verify the details column content is NOT ours by opening details with layout and checking no ssh-panel.
await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
await sleep(2500);
console.log('panel after reopen:', await ev(`!!document.querySelector('.ssh-panel')`));
console.log('prompt again:', await ev(`document.querySelector('.ssh-prompt-str')?.textContent ?? null`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:/Creative/dsh-ssh/test/shots/v1-column.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
edge.kill();
process.exit(0);
