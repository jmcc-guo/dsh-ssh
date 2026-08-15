/** CDP: step through workspace → session activation, then open SSH column. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9233',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-col4',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9233/json').then((r) => r.json());
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

// 1. click the dsh-ssh workspace row (projectRow)
console.log('workspace click:', await ev(`(() => {
  const rows = [...document.querySelectorAll('[class*="Row" i], li')];
  const ws = rows.find((el) => {
    const t = (el.textContent || '').trim();
    return /^dsh-ssh$|dsh-ssh\\s*$/.test(t) && t.length < 30;
  });
  if (!ws) return 'not found: ' + rows.slice(0, 8).map((r) => (r.textContent || '').trim().slice(0, 25)).join(' | ');
  ws.click();
  return 'clicked ' + JSON.stringify((ws.textContent || '').trim());
})()`));
await sleep(2000);

// 2. list session rows now visible
console.log('sessions now:', await ev(`[...document.querySelectorAll('[class*="sessionRow" i]')].slice(0, 10).map((el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50))`));

// 3. click the first session row
console.log('session click:', await ev(`(() => {
  const rows = [...document.querySelectorAll('[class*="sessionRow" i]')];
  if (rows.length === 0) return 'no session rows';
  rows[0].click();
  return 'clicked ' + JSON.stringify((rows[0].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40));
})()`));
await sleep(3000);

// 4. verify a session is active: look for composer + message nodes
console.log('composer exists:', await ev(`!!document.querySelector('[class*="composer" i]')`));
console.log('message area text:', await ev(`(() => { const el = document.querySelector('[class*="conversation" i], main, [class*="Chat" i]'); return el ? (el.textContent || '').trim().slice(0, 80) : 'none'; })()`));

// 5. open the SSH column via the rail
console.log('rail click:', await ev(`(() => { const rail = document.querySelector('.ssh-rail'); if (rail) { rail.click(); return 'clicked'; } return 'no rail'; })()`));
await sleep(2500);
console.log('column rect:', await ev(`(() => { const el = document.querySelector('.ssh-panel'); return el ? JSON.stringify({ left: Math.round(el.getBoundingClientRect().left), width: Math.round(el.getBoundingClientRect().width) }) : 'none'; })()`));
console.log('composer right:', await ev(`(() => { const el = document.querySelector('[class*="composer" i]'); return el ? Math.round(el.getBoundingClientRect().right) : 'none'; })()`));
console.log('prompt:', await ev(`document.querySelector('.ssh-prompt-str')?.textContent ?? null`));
ws.close();
edge.kill();
process.exit(0);
