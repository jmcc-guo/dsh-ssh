/**
 * dsh-ssh client scroll-behavior test — loads the SHIPPED client bundle
 * (lib/client.js) into jsdom with real React 18 and a simulated panel
 * WebSocket, then verifies the terminal's sticky-bottom behavior:
 *
 *  1. A large output burst keeps the view at the bottom (the old code
 *     measured the distance AFTER the content grew, so a burst bigger than
 *     90px detached the view from the bottom).
 *  2. A user who scrolled up to read history is NOT pulled down by ordinary
 *     output (manual reading is respected).
 *  3. When the AI starts operating the connection (busyBy -> 'ai'), the view
 *     re-pins and slides to the newest output — even while the user was
 *     reading history.
 *  4. The user can scroll up again during an AI operation to keep reading;
 *     the next AI operation re-pins the view.
 *  5. Switching to another tab opens it at its own bottom.
 *
 * Run: node scripts/test-client-scroll.mjs   (no SSH server needed)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dshCheckout = process.env.DSH_CHECKOUT ?? 'E:/Develop/Soft/deepseek-harness';
const dshRequire = createRequire(join(dshCheckout, 'package.json'));
const webRequire = createRequire(join(dshCheckout, 'apps/web/package.json'));

const { JSDOM } = dshRequire('jsdom');
const React = webRequire('react');
const { createRoot } = webRequire('react-dom/client');
const act = React.act ?? webRequire('react-dom/test-utils').act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// ---------------------------------------------------------------------------
// Browser contract: module loader sink + fake WebSocket
// ---------------------------------------------------------------------------

const factories = new Map();
window.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) };

let serverTabs = [];
let serverRecords = [];

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(data) {
    this.sent.push(data);
    const msg = JSON.parse(data);
    if (msg.method === 'snapshot') this.reply(msg.id, { result: { tabs: serverTabs, records: serverRecords } });
    else if (msg.method === 'terminalSnapshot') this.reply(msg.id, { result: { entries: [] } });
    else this.reply(msg.id, { result: { ok: true } });
  }
  reply(id, payload) {
    this.onmessage({ data: JSON.stringify({ id, ...payload }) });
  }
  close() { this.readyState = 3; }
}
FakeWS.instances = [];
window.WebSocket = FakeWS;

globalThis.window = window;
globalThis.document = document;
globalThis.WebSocket = FakeWS;
globalThis.location = window.location;

// ---------------------------------------------------------------------------
// Load and materialize the shipped bundle
// ---------------------------------------------------------------------------

const bundleSource = readFileSync(join(repoRoot, 'lib/client.js'), 'utf8');
(0, eval)(bundleSource);
const factory = factories.get('@jmcc-guo/dsh-ssh');
if (!factory) {
  console.error('FAIL bundle did not register a factory');
  process.exit(1);
}

const primitives = {
  StateDot: (props) => React.createElement('span', { 'data-state': props.state, 'data-size': props.size }),
  RiskConfirmation: () => null,
};
function fakeRequire(spec) {
  if (spec === 'react') return React;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`test: unexpected require("${spec}")`);
}
const mod = factory(fakeRequire);

// ---------------------------------------------------------------------------
// Fake plugin ctx (slots / locale / effects / layout)
// ---------------------------------------------------------------------------

const registered = new Map();
let localeTable;
const ctx = {
  effect(fn, name) { fn(); },
  locale: {
    register: (ns, table) => { localeTable = table; },
    bind: (ns) => (key) => (localeTable?.en?.[key] ?? key),
  },
  slots: {
    register: (desc, component) => { registered.set(desc.name, component); return () => registered.delete(desc.name); },
    inject: (name, cb) => { cb(); },
  },
  get: () => undefined,
};

// ---------------------------------------------------------------------------
// Server-side simulation helpers
// ---------------------------------------------------------------------------

let seq = 0;
const out = (text) => ({ seq: ++seq, kind: 'out', text, source: null, exitCode: null, execId: null });
const start = (text, source) => ({ seq: ++seq, kind: 'start', text, source, exitCode: null, execId: 'x' });
const end = (text, source, exitCode = 0) => ({ seq: ++seq, kind: 'end', text, source, exitCode, execId: 'x' });

function pushEvent(message) {
  const ws = FakeWS.instances.at(-1);
  if (!ws) throw new Error('test: no websocket');
  ws.onmessage({ data: JSON.stringify(message) });
}
function setTabs(tabs) {
  serverTabs = tabs;
  pushEvent({ event: 'state', state: { tabs: serverTabs, records: serverRecords } });
}
function terminal(name, entries) {
  pushEvent({ event: 'terminal', name, entries });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Boot the plugin, render the SSH column
// ---------------------------------------------------------------------------

serverTabs = [{ key: 't1', name: 'dgx', source: 'ai', status: 'connected', busyBy: null }];
serverRecords = [];

await act(async () => {
  mod.apply(ctx);
  await sleep(20); // fake ws open + snapshot roundtrip
});
const SshColumn = registered.get('details');
if (!SshColumn) {
  console.error('FAIL details slot was never registered (panel did not auto-open)');
  process.exit(1);
}

// jsdom has no layout engine: fake the scroll geometry on the ELEMENT
// PROTOTYPE so it is in place BEFORE React's first effects run. The terminal
// code only ever reads/writes these on the .ssh-terminal-scroll element.
let fakeScrollTop = 0;
let fakeScrollHeight = 400;
const fakeClientHeight = 400;
Object.defineProperty(window.Element.prototype, 'scrollTop', {
  configurable: true,
  get: () => fakeScrollTop,
  set: (value) => { fakeScrollTop = Number(value); },
});
Object.defineProperty(window.Element.prototype, 'scrollHeight', { configurable: true, get: () => fakeScrollHeight });
Object.defineProperty(window.Element.prototype, 'clientHeight', { configurable: true, get: () => fakeClientHeight });

const container = document.getElementById('root');
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(SshColumn, { t: ctx.locale.bind('dsh-ssh'), sessionId: 's1' }));
});

const el = container.querySelector('.ssh-terminal-scroll');
if (!el) {
  console.error('FAIL terminal scroll element not rendered');
  process.exit(1);
}

const userScrollTo = (top) => {
  fakeScrollTop = top;
  el.dispatchEvent(new window.Event('scroll'));
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
}

// --- 1. initial mount: fresh terminal sits at its bottom --------------------
await act(async () => {
  fakeScrollHeight = 400;
});
check('fresh terminal opens at the bottom', fakeScrollTop === 400, `scrollTop=${fakeScrollTop}`);

// --- 2. a large burst follows to the bottom ----------------------------------
// (old behavior: measured the distance after the burst grew the area, so a
// burst > 90px detached the view from the bottom)
await act(async () => {
  fakeScrollHeight = 2000;
  terminal('t1', [out('line 1\r\nline 2\r\n'), out(Array.from({ length: 28 }, (_, i) => `bulk line ${i + 3}`).join('\r\n'))]);
});
check('large output burst keeps the view at the bottom', fakeScrollTop === 2000, `scrollTop=${fakeScrollTop} scrollHeight=${fakeScrollHeight}`);

// --- 3. user scrolls up: ordinary output must NOT pull them down ------------
userScrollTo(600);
await act(async () => {
  fakeScrollHeight = 2200;
  terminal('t1', [out('more output line\r\n')]);
});
check('scrolled-up reader is not pulled down by ordinary output', fakeScrollTop === 600, `scrollTop=${fakeScrollTop}`);

// --- 4. AI starts operating: view re-pins and slides to the newest output ----
await act(async () => {
  fakeScrollHeight = 2300;
  setTabs([{ key: 't1', name: 'dgx', source: 'ai', status: 'connected', busyBy: 'ai' }]);
  terminal('t1', [start('uname -a', 'ai'), out('Linux dgx 5.15.0\r\n')]);
});
check('AI operation start re-pins the view at the newest output', fakeScrollTop === 2300, `scrollTop=${fakeScrollTop} scrollHeight=${fakeScrollHeight}`);

// --- 5. AI keeps streaming: follow while pinned ------------------------------
await act(async () => {
  fakeScrollHeight = 2400;
  terminal('t1', [out(Array.from({ length: 5 }, (_, i) => `stream ${i}`).join('\r\n'))]);
});
check('AI output keeps following while pinned', fakeScrollTop === 2400, `scrollTop=${fakeScrollTop}`);

// --- 6. user scrolls up DURING an AI operation: may keep reading ------------
userScrollTo(900);
await act(async () => {
  fakeScrollHeight = 2500;
  terminal('t1', [out('still running…\r\n')]);
});
check('user can read history during an AI operation', fakeScrollTop === 900, `scrollTop=${fakeScrollTop}`);

// --- 7. command ends: no forced jump back ------------------------------------
await act(async () => {
  fakeScrollHeight = 2510;
  setTabs([{ key: 't1', name: 'dgx', source: 'ai', status: 'connected', busyBy: null }]);
  terminal('t1', [end('exit code: 0', 'ai', 0)]);
});
check('command end does not yank the reader back to the bottom', fakeScrollTop === 900, `scrollTop=${fakeScrollTop}`);

// --- 8. next AI operation re-pins again ---------------------------------------
await act(async () => {
  fakeScrollHeight = 2600;
  setTabs([{ key: 't1', name: 'dgx', source: 'ai', status: 'connected', busyBy: 'ai' }]);
  terminal('t1', [start('df -h', 'ai')]);
});
check('the next AI operation re-pins the view again', fakeScrollTop === 2600, `scrollTop=${fakeScrollTop}`);

// --- 9. tab switch opens the other tab at its own bottom ---------------------
await act(async () => {
  fakeScrollHeight = 1800;
  setTabs([
    { key: 't1', name: 'dgx', source: 'ai', status: 'connected', busyBy: 'ai' },
    { key: 't2', name: 'box2', source: 'ai', status: 'connected', busyBy: null },
  ]);
  terminal('t2', [out('banner\r\nuser@box2:~$')]);
});
await act(async () => {
  const tabs = [...container.querySelectorAll('.ssh-tab')];
  const tab2 = tabs.find((node) => node.textContent.includes('box2'));
  if (!tab2) throw new Error('test: second tab element not found');
  tab2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
});
check('switching tabs opens the new tab at its own bottom', fakeScrollTop === 1800, `scrollTop=${fakeScrollTop}`);

// ---------------------------------------------------------------------------

await act(async () => { root.unmount(); });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
