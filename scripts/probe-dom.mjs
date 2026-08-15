/** Inspect the workspace/session DOM in the headless page. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-ssh-edge-dom-'));
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9280',
  `--user-data-dir=${DATA_DIR}`,
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise((resolve) => setTimeout(resolve, 6000));
const targets = await fetch('http://127.0.0.1:9280/json').then((r) => r.json());
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
  return result.result?.result?.value;
};

console.log('workspace rows:', await ev(`JSON.stringify([...document.querySelectorAll('[class*="Row" i], li')].map((el) => (el.textContent||'').trim().slice(0,60)).filter(Boolean).slice(0,30))`));
console.log('sessionRow count:', await ev(`document.querySelectorAll('[class*="sessionRow" i]').length`));
console.log('body text head:', await ev(`document.body.innerText.slice(0, 400)`));
console.log('buttons:', await ev(`JSON.stringify([...document.querySelectorAll('button')].map((b) => (b.textContent||'').trim().slice(0,40)).filter(Boolean).slice(0,30))`));
console.log('inputs:', await ev(`JSON.stringify([...document.querySelectorAll('input,textarea')].map((i) => ({ph:i.placeholder||'', t:i.type||''})).slice(0,10))`));

ws.close();
edge.kill();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
