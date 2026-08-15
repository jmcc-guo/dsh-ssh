/** CDP v4: verify the "+" now opens a MODAL with saved connections + manual input. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9242',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-v4',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9242/json').then((r) => r.json());
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
await hreq('createRecord', { name: 'modal-box', host: '127.0.0.1', port: 2222, user: 'jmcc', password: 'testpass123' });
await hreq('exec', { name: 'modal-box', command: 'echo T' });
await new Promise((resolve) => setTimeout(resolve, 1200));

await ev(`(() => { const rows = [...document.querySelectorAll('[class*="Row" i], li')]; const wsRow = rows.find((el) => { const t = (el.textContent || '').trim(); return /^(dsh-ssh|dsh-agent-tool-manager|DgxSpark|LApp|qa_collector|astral-hub)$/.test(t); }); if (wsRow) wsRow.click(); })()`);
await sleep(2000);
await ev(`(() => { const rows = [...document.querySelectorAll('[class*="sessionRow" i]')]; if (rows.length) rows[0].click(); })()`);
await sleep(3000);
for (let attempt = 0; attempt < 4; attempt++) {
  await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) rail.click(); })()`);
  await sleep(2000);
  if ((await ev(`!!document.querySelector('.ssh-panel')`)) === true) break;
}

// click "+"
console.log('click +:', await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) { b.click(); return 'clicked'; } return 'no'; })()`));
await sleep(800);
console.log('modal open:', await ev(`!!document.querySelector('.ssh-addtab-modal')`));
console.log('modal title:', await ev(`document.querySelector('.ssh-addtab-modal h3')?.textContent ?? null`));
console.log('saved section title:', await ev(`[...document.querySelectorAll('.ssh-addtab-section-title')].map((el) => el.textContent)`));
console.log('saved list items:', await ev(`[...document.querySelectorAll('.ssh-addtab-list .ssh-tabmenu-item')].map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50))`));
console.log('manual form present:', await ev(`(() => { const m = document.querySelector('.ssh-addtab-modal'); return m ? !!m.querySelector('.ssh-form') : false; })()`));
console.log('form fields:', await ev(`[...document.querySelectorAll('.ssh-addtab-modal .ssh-field-label')].map((el) => el.textContent)`));

// pick a saved connection from the modal → tab opens, modal closes
console.log('pick saved:', await ev(`(() => { const items = [...document.querySelectorAll('.ssh-addtab-list .ssh-tabmenu-item')]; const pick = items.find((el) => (el.textContent || '').includes('modal-box')); if (pick) { pick.click(); return 'clicked'; } return 'none'; })()`));
await sleep(2000);
console.log('modal closed after pick:', await ev(`!document.querySelector('.ssh-addtab-modal')`));
console.log('tabs now:', await ev(`[...document.querySelectorAll('.ssh-tab-name')].map((e) => e.textContent)`));

// reopen + manual entry submit (create a second connection through the form)
await ev(`(() => { const b = document.querySelector('.ssh-tab-add'); if (b) b.click(); })()`);
await sleep(600);
console.log('fill manual form:', await ev(`(() => {
  const modal = document.querySelector('.ssh-addtab-modal');
  if (!modal) return 'no modal';
  const inputs = modal.querySelectorAll('input');
  const set = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const name = [...inputs].find((i) => i.placeholder === 'serverA' || i.placeholder === undefined);
  // fill by field labels: use the form's internal state via React? simpler: fill by order — name, host, port, user
  const fields = modal.querySelectorAll('.ssh-form input');
  set(fields[0], 'manual-box');
  set(fields[1], '127.0.0.1');
  set(fields[2], '2222');
  set(fields[3], 'jmcc');
  const pw = modal.querySelector('input[type="password"]');
  if (pw) set(pw, 'testpass123');
  return 'filled';
})()`));
await sleep(400);
console.log('submit:', await ev(`(() => { const b = [...document.querySelectorAll('.ssh-addtab-modal button')].find((el) => /创建并连接|Create/.test(el.textContent || '')); if (b) { b.click(); return 'clicked'; } return 'no'; })()`));
await sleep(3000);
console.log('modal closed:', await ev(`!document.querySelector('.ssh-addtab-modal')`));
console.log('tabs after manual:', await ev(`[...document.querySelectorAll('.ssh-tab-name')].map((e) => e.textContent)`));
console.log('error banner:', await ev(`document.querySelector('.ssh-addtab-modal .ssh-alert')?.textContent ?? null`));

await hreq('deleteRecord', { name: 'modal-box' });
await hreq('deleteRecord', { name: 'manual-box' });
ws.close();
host.close();
edge.kill();
process.exit(0);
