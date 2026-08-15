/** CDP: open Settings → SSH Connections section, verify CRUD UI. */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=9235',
  '--user-data-dir=C:/Users/JMCCPC/AppData/Local/Temp/dsh-ssh-edge-set1',
  '--window-size=1680,1050', 'http://127.0.0.1:3081/',
], { stdio: 'ignore' });

await new Promise((resolve) => setTimeout(resolve, 9000));
const targets = await fetch('http://127.0.0.1:9235/json').then((r) => r.json());
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

// open settings via the sidebar foot (gear) — click element with 设置 text
console.log('open settings:', await ev(`(() => {
  const candidates = [...document.querySelectorAll('[class*="row" i], [class*="item" i], li, button, a')];
  const gear = candidates.find((el) => (el.textContent || '').trim() === '设置' || (el.textContent || '').trim() === 'Settings');
  if (gear) { gear.click(); return 'clicked ' + gear.tagName; }
  const aria = [...document.querySelectorAll('[aria-label]')].find((el) => /settings|设置/i.test(el.getAttribute('aria-label') || ''));
  if (aria) { aria.click(); return 'clicked aria ' + aria.getAttribute('aria-label'); }
  return 'not found; candidates: ' + candidates.slice(0, 12).map((c) => (c.textContent || '').trim().slice(0, 20)).join(' | ');
})()`));
await sleep(2500);

// find the SSH connections section link and click it
console.log('settings sections:', await ev(`[...document.querySelectorAll('[class*="settings" i] [class*="nav" i] *, [class*="section" i]')].slice(0, 10).map((el) => (el.textContent || '').trim().slice(0, 40)).filter((t) => t.length > 0)`));
console.log('click ssh section:', await ev(`(() => {
  const items = [...document.querySelectorAll('button, [class*="item" i], [class*="row" i], a')];
  const ssh = items.find((el) => /SSH 连接|SSH Connections/.test(el.textContent || ''));
  if (ssh) { ssh.click(); return 'clicked'; }
  return 'not found';
})()`));
await sleep(2000);

console.log('settings page h2:', await ev(`document.querySelector('.ssh-settings-header h2')?.textContent ?? null`));
console.log('settings intro:', await ev(`document.querySelector('.ssh-settings-header p')?.textContent ?? null`));
console.log('new button:', await ev(`[...document.querySelectorAll('.ssh-settings-actions button')].map((b) => b.textContent)`));
console.log('rows:', await ev(`[...document.querySelectorAll('.ssh-settings-row')].map((row) => ({
  name: row.querySelector('.ssh-settings-row-name')?.textContent,
  meta: row.querySelector('.ssh-settings-row-meta')?.textContent,
  actions: [...row.querySelectorAll('button')].map((b) => b.textContent),
}))`));
console.log('has list column in panel:', await ev(`!!document.querySelector('.ssh-list')`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:/Creative/dsh-ssh/test/shots/settings-page.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot saved');
ws.close();
edge.kill();
process.exit(0);
