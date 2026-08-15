window.__ModuleLoader__.load({ id: "@jmcc-guo/dsh-ssh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

/**
 * @jmcc-guo/dsh-ssh — browser half.
 *
 * Three surfaces:
 *  - `details` column (priority -1): the SSH terminal panel as a real layout
 *    column — the conversation shrinks instead of being covered. Contains the
 *    tab bar, the transfer-to-AI strip (user-created active tab), and a LIVE
 *    terminal: each connection owns one real interactive shell whose
 *    banner/motd/prompt/echo render exactly like a native SSH client. There
 *    is no input box and no copy control — clicking the terminal focuses an
 *    invisible key catcher and keystrokes go straight into the remote shell.
 *  - `shell.overlay`: a slim right-edge rail to reopen the column when closed.
 *  - `settings.section`: the SSH connection management page — create, edit,
 *    delete, connect/disconnect and transfer connection records + credentials
 *    (the panel itself no longer does CRUD).
 * All state flows through one WebSocket at /ssh/ws; host state is the single
 * source of truth.
 */
const React = require('react');
const { createElement: h, Fragment, useEffect, useRef, useState, useSyncExternalStore, useCallback, useMemo } = React;
const { StateDot, RiskConfirmation } = require('@deepseek-ai/dsh-client-ui-primitives');

const NS = 'dsh-ssh';

// ---------------------------------------------------------------------------
// i18n (en / zh)
// ---------------------------------------------------------------------------

const en = {
  panelTitle: 'SSH Terminal',
  panelSubtitle: 'Remote connections managed by the AI agent',
  railOpen: 'Open SSH Terminal panel',
  collapse: 'Collapse',
  settingsTitle: 'SSH Connections',
  settingsIntro: 'Manage saved SSH connections and their credentials. Connections created by the AI also appear here.',
  settingsHint: 'Behaviour settings live under the dsh-ssh namespace in settings.yaml.',
  connectionsList: 'Saved Connections',
  chooseSaved: 'Choose from saved connections',
  emptyList: 'No saved connections yet. Create one below.',
  emptyListAi: 'The AI can also create connections by asking, e.g. "connect to serverA".',
  newConnection: 'New Connection',
  manualEntry: 'Manual entry…',
  addTab: 'Open a saved connection or create a new one',
  name: 'Name',
  host: 'Host',
  port: 'Port',
  user: 'User',
  auth: 'Auth',
  authPassword: 'Password',
  authKey: 'Private key',
  password: 'Password',
  privateKey: 'Private key',
  passphrase: 'Key passphrase (optional)',
  connect: 'Connect',
  disconnect: 'Disconnect',
  reconnect: 'Reconnect',
  delete: 'Delete',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  createAndConnect: 'Create & Connect',
  saveAndConnect: 'Save & Connect',
  sourceAi: 'AI',
  sourceUser: 'User',
  statusConnected: 'Connected',
  statusConnecting: 'Connecting',
  statusReconnecting: 'Reconnecting',
  statusDisconnected: 'Disconnected',
  statusError: 'Error',
  busyAi: 'AI is executing…',
  busyUser: 'Command running…',
  kill: 'Kill',
  terminalEmpty: 'Live terminal — click here and start typing. Commands run by the AI appear here too.',
  clickToType: 'Click the terminal to start typing',
  transferToAi: 'Transfer to AI',
  transferStrip: 'Created by you — transferring grants the AI remote command execution on this connection.',
  transferTitle: 'Transfer this connection to the AI?',
  transferDesc: 'The AI will immediately be able to see this connection and run remote commands on it (ssh_list / ssh_exec). This grants remote command execution rights and cannot be undone.',
  transferAck: 'I understand — grant the AI remote command execution on this connection',
  transferConfirm: 'Transfer',
  transferDone: 'Transferred to AI',
  deleteTitle: 'Delete saved connection "{name}"?',
  deleteDesc: 'The connection will be disconnected first if it is online. Other connections to the same server are not affected.',
  deleteConfirm: 'Delete',
  closeTabTip: 'Close tab',
  aiCmd: 'AI',
  userCmd: 'You',
  exitCode: 'exit code',
  killedLabel: 'killed',
  notice: 'notice',
  wsDisconnected: 'Panel link lost — reconnecting…',
  formError: 'Please fill in name, host, user and an auth method.',
  unnamed: '(unnamed)',
  running: 'running',
  offlineReconnect: 'Disconnected — reconnect to continue',
};

const zh = {
  panelTitle: 'SSH 终端',
  panelSubtitle: '由 AI 代理管理的远程连接',
  railOpen: '打开 SSH 终端面板',
  collapse: '收起',
  settingsTitle: 'SSH 连接',
  settingsIntro: '管理已保存的 SSH 连接与凭据。AI 创建的连接也会出现在这里。',
  settingsHint: '心跳、重连等行为设置位于 settings.yaml 的 dsh-ssh 命名空间。',
  connectionsList: '已保存连接',
  chooseSaved: '从已保存连接中选择',
  emptyList: '还没有保存的连接，请在下方新建。',
  emptyListAi: '也可以直接对 AI 说“连上 serverA”来创建连接。',
  newConnection: '新建连接',
  name: '名称',
  host: '主机',
  port: '端口',
  user: '用户',
  auth: '认证',
  authPassword: '密码',
  authKey: '私钥',
  password: '密码',
  privateKey: '私钥',
  passphrase: '私钥口令（可选）',
  connect: '连接',
  disconnect: '断开',
  reconnect: '重连',
  delete: '删除',
  edit: '编辑',
  save: '保存',
  cancel: '取消',
  createAndConnect: '创建并连接',
  saveAndConnect: '保存并连接',
  sourceAi: 'AI',
  sourceUser: '用户',
  statusConnected: '已连接',
  statusConnecting: '连接中',
  statusReconnecting: '重连中',
  statusDisconnected: '已断开',
  statusError: '错误',
  busyAi: 'AI 正在执行中…',
  busyUser: '命令执行中…',
  manualEntry: '手动输入连接…',
  addTab: '打开已保存连接或新建连接',
  kill: '终止',
  terminalEmpty: '实时终端——点击此处后直接输入。AI 执行的命令也会显示在这里。',
  clickToType: '点击终端后即可输入',
  transferToAi: '转移给 AI',
  transferStrip: '该连接由你创建——转移后将授予 AI 远程命令执行权限。',
  transferTitle: '将该连接转移给 AI？',
  transferDesc: '转移后 AI 立即可见该连接并可在其上执行远程命令（ssh_list / ssh_exec）。这相当于授予 AI 远程命令执行权限，且不可撤销。',
  transferAck: '我已知晓——授予 AI 在此连接上执行远程命令的权限',
  transferConfirm: '转移',
  transferDone: '已转移给 AI',
  deleteTitle: '删除已保存连接“{name}”？',
  deleteDesc: '若连接在线会先断开。同一服务端的其他连接不受影响。',
  deleteConfirm: '删除',
  closeTabTip: '关闭标签',
  aiCmd: 'AI',
  userCmd: '你',
  exitCode: '退出码',
  killedLabel: '已终止',
  notice: '提示',
  wsDisconnected: '面板连接丢失——正在重连…',
  formError: '请填写名称、主机、用户并选择一种认证方式。',
  unnamed: '（未命名）',
  running: '执行中',
  offlineReconnect: '已断开——点击重连继续',
};

// ---------------------------------------------------------------------------
// Tiny store
// ---------------------------------------------------------------------------

function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(partial) {
      state = typeof partial === 'function' ? partial(state) : { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function useStore(store, selector) {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}

// ---------------------------------------------------------------------------
// ANSI rendering
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[([0-9;?]*)([A-Za-z@`])/g;

/** Parse one text line into styled spans. */
function parseAnsiLine(text) {
  // Drop OSC title sequences (BEL or ST terminated) and stray C0 controls
  // before CSI parsing.
  text = String(text)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
  const spans = [];
  let last = 0;
  let fg = null;
  let bg = null;
  let bold = false;
  let italic = false;
  let underline = false;
  let inverse = false;
  const push = (end, style) => {
    if (end > last) {
      const t = text.slice(last, end);
      if (t.length > 0) spans.push({ text: t, style });
    }
  };
  let match;
  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(text)) !== null) {
    const params = match[1];
    const cmd = match[2];
    push(match.index, spanStyle(fg, bg, bold, italic, underline, inverse));
    last = ANSI_RE.lastIndex;
    if (cmd === 'm' && params !== '') {
      const parts = params.split(';');
      for (let i = 0; i < parts.length; i++) {
        const code = parts[i] === '' ? 0 : Number(parts[i]);
        if (code === 0) { fg = null; bg = null; bold = false; italic = false; underline = false; inverse = false; }
        else if (code === 1) bold = true;
        else if (code === 3) italic = true;
        else if (code === 4) underline = true;
        else if (code === 7) inverse = true;
        else if (code === 22) bold = false;
        else if (code === 23) italic = false;
        else if (code === 24) underline = false;
        else if (code === 27) inverse = false;
        else if (code === 39) fg = null;
        else if (code === 49) bg = null;
        else if (code >= 30 && code <= 37) fg = code - 30;
        else if (code >= 90 && code <= 97) fg = code - 90 + 8;
        else if (code >= 40 && code <= 47) bg = code - 40;
        else if (code >= 100 && code <= 107) bg = code - 100 + 8;
        else if (code === 38 && parts[i + 1] === '5') { fg = Number(parts[i + 2]); i += 2; }
        else if (code === 48 && parts[i + 1] === '5') { bg = Number(parts[i + 2]); i += 2; }
        else if (code === 38 && parts[i + 1] === '2') { fg = [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])]; i += 4; }
        else if (code === 48 && parts[i + 1] === '2') { bg = [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])]; i += 4; }
      }
    }
  }
  push(text.length, spanStyle(fg, bg, bold, italic, underline, inverse));
  return spans;
}

const ANSI_COLORS = ['#4d545c', '#c24038', '#7f9f3f', '#d19a3a', '#4f7fd9', '#a471c9', '#3f9f9f', '#c9cdd3', '#6b7280', '#e0554c', '#9fc05a', '#e0b84f', '#6f9bef', '#c49ae0', '#5fbdbd', '#f5f7fa'];

function spanStyle(fg, bg, bold, italic, underline, inverse) {
  const style = {};
  if (fg !== null) {
    const color = Array.isArray(fg) ? `rgb(${fg[0]},${fg[1]},${fg[2]})` : ANSI_COLORS[fg] ?? '#eee';
    style.color = inverse ? (bg !== null ? (Array.isArray(bg) ? `rgb(${bg[0]},${bg[1]},${bg[2]})` : ANSI_COLORS[bg] ?? '#222') : '#222') : color;
    if (inverse && bg === null) style.backgroundColor = '#ccc';
  }
  if (bg !== null && !inverse) {
    style.backgroundColor = Array.isArray(bg) ? `rgb(${bg[0]},${bg[1]},${bg[2]})` : ANSI_COLORS[bg] ?? '#333';
  }
  if (bold) style.fontWeight = 700;
  if (italic) style.fontStyle = 'italic';
  if (underline) style.textDecoration = 'underline';
  return Object.keys(style).length > 0 ? style : undefined;
}

// ---------------------------------------------------------------------------
// WebSocket channel
// ---------------------------------------------------------------------------

let ws = null;
let wsConnected = false;
let pending = new Map();
let requestSeq = 0;
let reconnectTimer = null;

function openWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}/ssh/ws`);
  ws.onopen = () => {
    wsConnected = true;
    store.set({ wsConnected: true });
    request('snapshot', {}).then((result) => {
      applyState(result);
      // Reconcile terminal backlogs: fetch anything newer than the local
      // seq for every open tab. The link may have attached (or reconnected)
      // in the middle of a stream, so 'terminal' events can be missed and
      // the host does not replay them.
      const { tabs, terminals } = store.get();
      for (const tab of tabs) {
        const terminal = terminals[tab.key];
        const since = terminal ? terminal.seq : 0;
        request('terminalSnapshot', { tab: tab.key, since }).then((r) => {
          if (r && r.entries && r.entries.length) appendTerminal(tab.key, r.entries);
        }).catch(() => {});
      }
    }).catch(() => {});
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch { return; }
    if (message.id !== undefined && message.id !== null) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      }
      return;
    }
    handleEvent(message);
  };
  ws.onclose = () => {
    wsConnected = false;
    store.set({ wsConnected: false });
    for (const entry of pending.values()) entry.reject(new Error('panel link lost'));
    pending.clear();
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openWs();
  }, 2000);
}

function request(method, params = {}) {
  openWs();
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error('panel link not ready'));
      return;
    }
    const id = ++requestSeq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = createStore({
  wsConnected: false,
  records: [],
  tabs: [],
  active: null,
  terminals: {},
  panelOpen: false,
  lastSessionId: null,
  formOpen: false,
  tabAddOpen: false,
  editing: null,
  transferName: null,
  transferDone: false,
  deleteName: null,
  notices: {},
});

/** Tab objects are {key, name, status, source, ...}; keep only valid ones. */
function normalizeTabs(list) {
  return (list ?? []).filter((tab) => tab && typeof tab === 'object' && tab.key);
}

function applyState(state) {
  store.set((current) => {
    const records = state.records ?? [];
    const tabs = normalizeTabs(state.tabs);
    const active = current.active !== null && tabs.some((tab) => tab.key === current.active)
      ? current.active
      : (tabs[0]?.key ?? null);
    const prevTabs = current.tabs;
    const terminals = { ...current.terminals };
    for (const tab of tabs) {
      if (!terminals[tab.key]) terminals[tab.key] = { lines: [], current: '', seq: 0 };
    }
    for (const name of Object.keys(terminals)) {
      if (!tabs.some((tab) => tab.key === name)) delete terminals[name];
    }
    // Auto-open the panel when a NEW tab appeared (e.g. the AI connected).
    const added = tabs.some((tab) => !prevTabs.some((prev) => prev.key === tab.key));
    let panelOpen = current.panelOpen;
    if (added && !panelOpen) panelOpen = true;
    return { ...current, records, tabs, active, terminals, panelOpen };
  });
}

function appendTerminal(name, entries) {
  store.set((current) => {
    const terminals = { ...current.terminals };
    const tab = terminals[name] ?? { lines: [], current: '', bytes: 0, seq: 0 };
    let lines = [...tab.lines];
    let currentLine = tab.current;
    let bytes = tab.bytes;
    let seq = tab.seq;
    for (const entry of entries) {
      if (entry.seq <= seq) continue;
      seq = entry.seq;
      if (entry.kind === 'out') {
        const fed = feedLines(lines, currentLine, bytes, String(entry.text));
        lines = fed.lines;
        currentLine = fed.currentLine;
        bytes = fed.bytes;
      } else {
        // Marker / end / notice entries are full lines: commit whatever is
        // still being typed first, then add the marker line.
        if (currentLine !== '') {
          lines.push({ type: 'text', text: currentLine });
          bytes += currentLine.length + 32;
          currentLine = '';
        }
        const text = String(entry.text);
        if (entry.kind === 'start') {
          lines.push({ type: 'marker', source: entry.source, text });
        } else if (entry.kind === 'end') {
          lines.push({ type: 'end', source: entry.source, text, exitCode: entry.exitCode });
        } else {
          lines.push({ type: 'notice', text });
        }
        bytes += text.length + 32;
      }
    }
    // cap lines (~2MB text); drop from the front while over budget.
    while (lines.length > 2 && bytes > 2000000) {
      bytes -= lines[0].text.length + 32;
      lines.shift();
    }
    terminals[name] = { lines, current: currentLine, bytes, seq };
    return { ...current, terminals };
  });
}

function handleEvent(message) {
  if (message.event === 'state') {
    applyState(message.state);
    return;
  }
  if (message.event === 'terminal') {
    appendTerminal(message.name, message.entries ?? []);
  }
}

// ---------------------------------------------------------------------------
// Terminal text helpers
// ---------------------------------------------------------------------------

/**
 * Feed a chunk of raw terminal output into the line model, with real-terminal
 * editing semantics: CRLF/LF commit the current line, a lone CR overwrites it
 * in place (progress bars, in-place prompt redraws), backspace removes the
 * last character, and erase-to-end / erase-line escapes truncate it. Other
 * escape sequences pass through (parseAnsiLine strips them at render).
 *
 * STATE IS CARRIED ACROSS CALLS: the uncommitted current line persists
 * between entries, because shells split the stream into tiny chunks — the
 * DGX bash echoes each typed character as its own data chunk, and the
 * CRLF that commits a line arrives in a LATER chunk. Stateless per-chunk
 * assembly would render every keystroke as its own line.
 *
 * @param lines - committed lines array (mutated and returned).
 * @param current - the live uncommitted line.
 * @param bytes - running byte estimate of `lines` (for the cap).
 * @param text - the raw chunk.
 * @returns {lines, currentLine, bytes}.
 */
function feedLines(lines, current, bytes, text) {
  const commit = () => {
    lines.push({ type: 'text', text: current });
    bytes += current.length + 32;
  };
  let i = 0;
  const n = String(text).length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        commit();
        current = '';
        i += 2;
        continue;
      }
      current = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      commit();
      current = '';
      i += 1;
      continue;
    }
    if (ch === '\b') {
      // Remove one character (also skips a trailing ANSI escape).
      current = current.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]$/, '').slice(0, -1);
      i += 1;
      continue;
    }
    if (ch === '\x1b') {
      const rest = text.slice(i);
      const eraseToEnd = rest.match(/^\x1b\[K/);
      if (eraseToEnd) {
        current = current.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]$/, '');
        i += eraseToEnd[0].length;
        continue;
      }
      const eraseLine = rest.match(/^\x1b\[2K/);
      if (eraseLine) {
        current = '';
        i += eraseLine[0].length;
        continue;
      }
      const csi = rest.match(/^\x1b\[[0-9;?]*[A-Za-z@`~]/);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      const osc = rest.match(/^\x1b\][\s\S]*?(?:\x07|\x1b\\)/);
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    // Skip other C0 control characters (BEL, NUL, …) — they are not text.
    if (ch < ' ' && ch !== '\t') {
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  return { lines, currentLine: current, bytes };
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function statusTone(status) {
  switch (status) {
    case 'connected': return 'done';
    case 'connecting': return 'ongoing';
    case 'reconnecting': return 'warning';
    default: return 'error';
  }
}

function statusText(t, status) {
  switch (status) {
    case 'connected': return t('statusConnected');
    case 'connecting': return t('statusConnecting');
    case 'reconnecting': return t('statusReconnecting');
    case 'disconnected': return t('statusDisconnected');
    default: return t('statusError');
  }
}

function SourceBadge({ source, t }) {
  if (source === 'ai') {
    return h('span', { className: 'ssh-badge ssh-badge-ai', title: t('sourceAi') }, 'AI');
  }
  return h('span', { className: 'ssh-badge ssh-badge-user', title: t('sourceUser') }, h('span', { className: 'ssh-badge-user-icon' }, '\u{1F464}'));
}

function flashError(message) {
  store.set({ lastError: message });
  setTimeout(() => store.set({ lastError: null }), 4000);
}

function recordOf(name) {
  return store.get().records.find((record) => record.name === name);
}

// ---------------------------------------------------------------------------
// Overlay rail (shown while the SSH column is closed)
// ---------------------------------------------------------------------------

function OverlayRail({ t }) {
  const panelOpen = useStore(store, (s) => s.panelOpen);
  if (panelOpen) return null;
  return h('div', {
    className: 'ssh-rail',
    onClick: () => store.set({ panelOpen: true }),
    title: t('railOpen'),
    'aria-label': t('railOpen'),
  }, h('span', { className: 'ssh-rail-label' }, 'SSH'));
}

// ---------------------------------------------------------------------------
// SSH column (details slot occupant)
// ---------------------------------------------------------------------------

function SshColumn({ t, sessionId }) {
  const wsConnected = useStore(store, (s) => s.wsConnected);

  // The layout closes the details column on session switches; follow it so
  // the overlay rail reappears instead of an invisible open panel. The
  // first mount (or a remount for the same session) only records the
  // session id — it must NOT close the panel it just opened.
  useEffect(() => {
    const prev = store.get().lastSessionId;
    if (prev === sessionId) return;
    const wasNull = prev === null;
    store.set({ lastSessionId: sessionId, ...(wasNull ? {} : { panelOpen: false }) });
  }, [sessionId]);

  return h('div', { className: 'ssh-panel' }, [
    h('header', { className: 'ssh-panel-header' }, [
      h('div', { className: 'ssh-panel-title' }, [
        h('span', { className: 'ssh-panel-kicker' }, 'dsh-ssh'),
        h('h2', null, t('panelTitle')),
      ]),
      h('div', { className: 'ssh-panel-actions' }, [
        !wsConnected ? h('span', { className: 'ssh-ws-state', title: t('wsDisconnected') }, '\u25CF') : null,
        h('button', {
          type: 'button', className: 'ssh-btn ssh-btn-ghost ssh-collapse', title: t('collapse'),
          onClick: () => store.set({ panelOpen: false }),
        }, '\u203A'),
      ]),
    ]),
    h('div', { className: 'ssh-panel-body' }, [
      h('div', { className: 'ssh-main' }, [
        h(TabBar, { t }),
        h(TransferStrip, { t }),
        h(TerminalArea, { t }),
      ]),
    ]),
    h(FormModal, { t }),
    h(AddTabModal, { t }),
    h(TransferDialog, { t }),
    h(DeleteDialog, { t }),
  ]);
}

// ---- tab bar ---------------------------------------------------------------

function TabBar({ t }) {
  const tabs = useStore(store, (s) => s.tabs);
  const active = useStore(store, (s) => s.active);

  // Close a tab immediately: disconnect + drop the tab, no confirmation.
  const closeTab = (key) => {
    request('closeTab', { tab: key }).then(() => {
      store.set((current) => {
        const next = current.tabs.filter((tab) => tab.key !== key);
        return {
          ...current,
          tabs: next,
          active: current.active === key ? (next[0]?.key ?? null) : current.active,
        };
      });
    }).catch((error) => flashError(error.message));
  };

  return h('div', { className: 'ssh-tabs' }, [
    ...tabs.map((tab) => {
      const status = tab.status ?? 'disconnected';
      const source = tab.source ?? 'ai';
      return h('div', {
        key: tab.key,
        className: 'ssh-tab' + (active === tab.key ? ' ssh-tab-active' : ''),
        onClick: () => store.set({ active: tab.key }),
        title: `${tab.name} — ${statusText(t, status)}`,
      }, [
        h(StateDot, { state: statusTone(status), size: 8 }),
        h('span', { className: 'ssh-tab-name' }, tab.name),
        h(SourceBadge, { source, t }),
        h('button', {
          type: 'button',
          className: 'ssh-tab-close',
          title: t('closeTabTip'),
          onClick: (event) => {
            event.stopPropagation();
            closeTab(tab.key);
          },
        }, '\u00D7'),
      ]);
    }),
    h(AddTabButton, { t }),
  ]);
}

/** "+" at the end of the tab bar: opens the add-tab dialog. */
function AddTabButton({ t }) {
  return h('div', { className: 'ssh-tabadd-wrap' }, [
    h('button', {
      type: 'button',
      className: 'ssh-tab-add',
      title: t('addTab'),
      'aria-label': t('addTab'),
      onClick: () => store.set({ tabAddOpen: true }),
    }, '+'),
  ]);
}

/**
 * The add-tab dialog: choose from saved connections (each click opens a NEW
 * tab — a fresh session, even when the same connection is already connected
 * in another tab), or manually enter a brand-new connection.
 */
function AddTabModal({ t }) {
  const open = useStore(store, (s) => s.tabAddOpen);
  const records = useStore(store, (s) => s.records);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  if (!open) return null;

  const close = () => store.set({ tabAddOpen: false });

  const openNewSession = (name) => {
    setBusy(true);
    setError(null);
    request('openNewSession', { name }).then((result) => {
      setBusy(false);
      if (result && result.error && !result.ok) {
        setError(result.error);
        return;
      }
      if (result && result.key) store.set({ active: result.key });
      close();
    }).catch((err) => {
      setBusy(false);
      setError(err.message);
    });
  };

  const onSubmit = (fields) => {
    setBusy(true);
    request('createRecord', fields).then((result) => {
      setBusy(false);
      if (result && result.error && !result.ok) {
        setError(result.error);
        return;
      }
      request('connect', { name: fields.name }).then(() => {
        store.set({ active: fields.name });
        close();
      }).catch((err) => flashError(err.message));
    }).catch((err) => {
      setBusy(false);
      setError(err.message);
    });
  };

  return h('div', { className: 'ssh-modal-mask', onClick: busy ? undefined : close }, [
    h('div', { className: 'ssh-modal ssh-addtab-modal', onClick: (event) => event.stopPropagation() }, [
      h('h3', null, t('addTab')),
      h('div', { className: 'ssh-addtab-section-title' }, t('chooseSaved')),
      records.length === 0
        ? h('div', { className: 'ssh-tabmenu-empty' }, t('emptyList'))
        : h('div', { className: 'ssh-addtab-list' },
            records.map((record) => h('button', {
              key: record.name,
              type: 'button',
              className: 'ssh-tabmenu-item',
              disabled: busy,
              onClick: () => openNewSession(record.name),
              title: `${record.user}@${record.host}:${record.port}`,
            }, [
              h(StateDot, { state: statusTone(record.status), size: 8 }),
              h('span', { className: 'ssh-tabmenu-item-name' }, record.name),
              h(SourceBadge, { source: record.source, t }),
              h('span', { className: 'ssh-tabmenu-item-host' }, `${record.user}@${record.host}:${record.port}`),
            ])),
          ),
      h('div', { className: 'ssh-addtab-divider' }),
      h('div', { className: 'ssh-addtab-section-title' }, t('manualEntry')),
      h(ConnectionForm, { t, submitLabel: t('createAndConnect'), onSubmit, onCancel: close, busy, error }),
    ]),
  ]);
}

// ---- transfer strip (user-created active tab) ------------------------------

function TransferStrip({ t }) {
  const active = useStore(store, (s) => s.active);
  const tabs = useStore(store, (s) => s.tabs);
  const tab = tabs.find((item) => item.key === active);
  if (!tab || tab.source !== 'user') return null;
  return h('div', { className: 'ssh-transfer-strip' }, [
    h('span', { className: 'ssh-transfer-strip-text' }, t('transferStrip')),
    h('button', {
      type: 'button',
      className: 'ssh-btn ssh-btn-mini ssh-btn-transfer',
      onClick: () => store.set({ transferName: tab.name, transferDone: false }),
    }, t('transferToAi')),
  ]);
}

// ---- terminal area -----------------------------------------------------------

function TerminalArea({ t }) {
  const active = useStore(store, (s) => s.active);
  const tabs = useStore(store, (s) => s.tabs);
  const terminals = useStore(store, (s) => s.terminals);
  const lastError = useStore(store, (s) => s.lastError);
  const tab = tabs.find((item) => item.key === active);
  const terminal = active ? terminals[active] : undefined;

  useEffect(() => {
    if (active && terminal && terminal.seq === 0) {
      request('terminalSnapshot', { tab: active, since: 0 }).then((result) => {
        if (result && result.entries) appendTerminal(active, result.entries);
      }).catch(() => {});
    }
  }, [active, terminal ? terminal.seq : 0]);

  if (!active || !tab) {
    return h('div', { className: 'ssh-terminal-empty' }, t('terminalEmpty'));
  }
  return h('div', { className: 'ssh-terminal-wrap' }, [
    h(TerminalHeader, { t, tab }),
    h(TerminalView, {
      t,
      tab,
      lines: terminal ? terminal.lines : [],
      current: terminal ? terminal.current : '',
      name: active,
    }),
    lastError ? h('div', { className: 'ssh-error-banner' }, lastError) : null,
  ]);
}

function TerminalHeader({ t, tab }) {
  const busyBy = tab.busyBy ?? null;
  return h('div', { className: 'ssh-term-header' }, [
    h(SourceBadge, { source: tab.source, t }),
    h('span', { className: 'ssh-term-header-name' }, `${tab.user}@${tab.host}:${tab.port}`),
    h('span', { className: 'ssh-status-text ssh-status-' + tab.status }, statusText(t, tab.status)),
    busyBy !== null
      ? h('span', { className: 'ssh-term-header-busy' }, busyBy === 'ai' ? t('busyAi') : t('busyUser'))
      : null,
    busyBy !== null
      ? h('button', {
          type: 'button', className: 'ssh-btn ssh-btn-mini ssh-btn-danger',
          onClick: () => request('killCommand', { tab: tab.key }).catch((error) => flashError(error.message)),
        }, t('kill'))
      : null,
    tab.lastError ? h('span', { className: 'ssh-term-header-error', title: tab.lastError }, tab.lastError) : null,
    tab.status === 'disconnected'
      ? h('button', {
          type: 'button', className: 'ssh-btn ssh-btn-mini ssh-btn-primary',
          onClick: () => request('connect', { tab: tab.key }).catch((error) => flashError(error.message)),
        }, t('reconnect'))
      : null,
  ]);
}

/** Terminal key mappings sent to the remote shell (xterm-style sequences). */
const KEYMAP = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

/**
 * Invisible keyboard catcher. It is never rendered as a control — zero
 * opacity, no border, no caret, pointer-events none — so the terminal looks
 * like a pure terminal. Keystrokes (including control keys and IME input)
 * are forwarded to the remote shell through the host's `input` method.
 * Focus changes are reported so the terminal can show the blinking cursor.
 */
function TerminalInput({ name, disabled, offline, catcherRef, t, onFocusChange }) {
  const composing = useRef(false);

  const send = (data) => {
    request('input', { name, data }).then((result) => {
      if (result && result.error && !result.ok && !result.blocked) flashError(result.error);
    }).catch(() => {});
  };

  const onKeyDown = (event) => {
    if (disabled || offline) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'v' || event.key === 'V') return; // let the paste event fire
      const lower = String(event.key).toLowerCase();
      if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
        event.preventDefault();
        send(String.fromCharCode(lower.charCodeAt(0) - 96));
      } else if (event.key === '[') {
        event.preventDefault();
        send('\x1b');
      }
      return;
    }
    if (event.altKey) return;
    const mapped = KEYMAP[event.key];
    if (mapped !== undefined) {
      event.preventDefault();
      send(mapped);
      return;
    }
    if (event.key === 'Process' || event.key === 'Unidentified') return; // IME composition
    if (event.key.length === 1) {
      event.preventDefault();
      send(event.key);
    }
  };

  const onPaste = (event) => {
    event.preventDefault();
    if (disabled || offline) return;
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (text) send(text);
  };

  return h('input', {
    ref: catcherRef,
    className: 'ssh-terminal-catcher',
    disabled: disabled || offline,
    onKeyDown,
    onPaste,
    onFocus: () => onFocusChange(true),
    onBlur: () => onFocusChange(false),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event) => {
      composing.current = false;
      if (!disabled && !offline && event.data) send(event.data);
      if (catcherRef.current) catcherRef.current.value = '';
    },
    onInput: () => {
      if (!composing.current && catcherRef.current && catcherRef.current.value !== '') {
        send(catcherRef.current.value);
        catcherRef.current.value = '';
      }
    },
    autoCapitalize: 'off',
    autoCorrect: 'off',
    spellCheck: false,
    autoComplete: 'off',
    'aria-label': t('clickToType'),
  });
}

function TerminalView({ t, tab, lines, current, name }) {
  const scrollRef = useRef(null);
  const wrapRef = useRef(null);
  const catcherRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const busyBy = tab?.busyBy ?? null;
  const aiSource = tab?.source === 'ai';
  const inputDisabled = aiSource && busyBy !== null;
  const offline = (tab?.status ?? 'disconnected') !== 'connected';
  // The blinking cursor appears at the input position while the terminal is
  // focused and the shell is user-controllable.
  const showCursor = focused && !offline && !inputDisabled;

  // Stick to the bottom while new output arrives — unless the user has
  // scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 90) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, current, name]);

  // NOTE: no auto-focus — the invisible catcher is focused only by an
  // explicit click, so opening the panel or switching tabs never steals
  // keystrokes from the chat composer into the remote shell.

  // NOTE: the pty deliberately keeps its default size (160×40) and long lines
  // wrap at the container width via CSS. Resizing the pty triggers readline
  // SIGWINCH redraws whose stray `\r` bytes garble the line-based renderer,
  // so no automatic resize is sent. The host `resize` method remains for
  // explicit callers and applies resizes only while the shell is quiet.

  const focusCatcher = () => {
    if (!inputDisabled && !offline && catcherRef.current) catcherRef.current.focus();
  };

  const rendered = [];
  for (const line of lines) {
    if (line.type === 'marker') {
      rendered.push(h('div', { className: 'ssh-line ssh-line-marker ssh-source-' + (line.source ?? '') }, [
        h('span', { className: 'ssh-source-tag ssh-source-tag-' + (line.source ?? '') }, line.source === 'ai' ? t('aiCmd') : t('userCmd')),
        h('span', { className: 'ssh-marker-cmd' }, line.text),
      ]));
    } else if (line.type === 'end') {
      rendered.push(h('div', { className: 'ssh-line ssh-line-end' }, line.text));
    } else if (line.type === 'notice') {
      rendered.push(h('div', { className: 'ssh-line ssh-line-notice' }, line.text));
    } else {
      const spans = parseAnsiLine(line.text);
      if (spans.length === 0) {
        rendered.push(h('div', { className: 'ssh-line' }, '\u00A0'));
        continue;
      }
      rendered.push(h('div', { className: 'ssh-line' },
        spans.map((span, index) => span.style
          ? h('span', { key: index, style: span.style }, span.text)
          : h(Fragment, { key: index }, span.text)),
      ));
    }
  }
  // The live uncommitted line (the shell prompt with anything typed so far).
  // The blinking block cursor sits at the end of it while the terminal is
  // focused — exactly where the next keystroke lands.
  const liveSpans = parseAnsiLine(current);
  if (liveSpans.length > 0) {
    const children = liveSpans.map((span, index) => span.style
      ? h('span', { key: index, style: span.style }, span.text)
      : h(Fragment, { key: index }, span.text));
    if (showCursor) {
      children.push(h('span', { key: 'cursor', className: 'ssh-term-cursor', 'aria-hidden': true }, '\u2588'));
    }
    rendered.push(h('div', { className: 'ssh-line' }, children));
  }

  // Pure live terminal: scrollback only. The prompt, the banner and the echo
  // all come from the remote shell; the invisible catcher makes keystrokes
  // flow into it. No input box, no copy control.
  return h('div', {
    ref: wrapRef,
    className: 'ssh-terminal-wrap2' + (inputDisabled ? ' ssh-terminal-blocked' : ''),
    onClick: focusCatcher,
    onMouseDown: focusCatcher,
    title: offline ? t('offlineReconnect') : t('clickToType'),
  }, [
    h('div', { className: 'ssh-terminal-scroll', ref: scrollRef }, lines.length === 0 && current === ''
      ? h('div', { className: 'ssh-terminal-empty' }, t('terminalEmpty'))
      : rendered),
    inputDisabled
      ? h('div', { className: 'ssh-terminal-busy' }, t('busyAi'))
      : null,
    h(TerminalInput, { name, disabled: inputDisabled, offline, catcherRef, t, onFocusChange: setFocused }),
  ]);
}

// ---- forms ----------------------------------------------------------------------

function FormModal({ t }) {
  const formOpen = useStore(store, (s) => s.formOpen);
  const editing = useStore(store, (s) => s.editing);
  const records = useStore(store, (s) => s.records);
  const record = editing ? records.find((r) => r.name === editing) : undefined;
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    store.set({ formOpen: false, editing: null });
    setError(null);
  };

  useEffect(() => {
    if (!formOpen) return;
    setError(null);
  }, [formOpen, editing]);

  if (!formOpen) return null;

  const onSubmit = (fields, connectAfter) => {
    setBusy(true);
    const method = editing ? 'updateRecord' : 'createRecord';
    const params = { ...fields };
    if (editing) {
      params.name = editing;
      if (fields.name !== editing) params.newName = fields.name;
    }
    request(method, params).then((result) => {
      setBusy(false);
      if (result && result.error && !result.ok) {
        setError(result.error);
        return;
      }
      if (!editing && connectAfter) {
        request('connect', { name: fields.name }).catch(() => {});
      }
      close();
    }).catch((error) => {
      setBusy(false);
      setError(error.message);
    });
  };

  return h('div', { className: 'ssh-modal-mask', onClick: busy ? undefined : close }, [
    h('div', { className: 'ssh-modal', onClick: (event) => event.stopPropagation() }, [
      h('h3', null, editing ? t('edit') : t('newConnection')),
      h(ConnectionForm, {
        t, initial: record, showSaveAndConnect: !editing, submitLabel: t('save'),
        onSubmit, onCancel: close, busy, error,
      }),
    ]),
  ]);
}

function ConnectionForm({ t, initial, submitLabel, onSubmit, onCancel, busy, error, showSaveAndConnect }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [user, setUser] = useState(initial?.user ?? '');
  const [authType, setAuthType] = useState(initial?.authType ?? 'password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [localError, setLocalError] = useState(null);

  const submit = (connectAfter) => {
    if (!name.trim() || !host.trim() || !user.trim()) {
      setLocalError(t('formError'));
      return;
    }
    if (authType === 'password' && !password && initial?.authType !== 'password') {
      setLocalError(t('formError'));
      return;
    }
    if (authType === 'key' && !privateKey && initial?.authType !== 'privateKey') {
      setLocalError(t('formError'));
      return;
    }
    const fields = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port || 22),
      user: user.trim(),
      password: authType === 'password' && password ? password : undefined,
      privateKey: authType === 'key' && privateKey ? privateKey : undefined,
      passphrase: authType === 'key' && passphrase ? passphrase : undefined,
    };
    onSubmit(fields, connectAfter);
  };

  const field = (label, value, onChange, placeholder, extra) => h('label', { className: 'ssh-field' }, [
    h('span', { className: 'ssh-field-label' }, label),
    h('input', { className: 'ssh-input', value, placeholder, onChange: (event) => onChange(event.target.value), autoComplete: 'off', ...extra }),
  ]);

  return h('div', { className: 'ssh-form' }, [
    field(t('name'), name, setName, 'serverA'),
    field(t('host'), host, setHost, '10.0.0.5'),
    h('div', { className: 'ssh-form-row' }, [
      field(t('port'), port, setPort, '22'),
      field(t('user'), user, setUser, 'root'),
    ]),
    h('div', { className: 'ssh-form-row' }, [
      h('label', { className: 'ssh-field' }, [
        h('span', { className: 'ssh-field-label' }, t('auth')),
        h('select', { className: 'ssh-input', value: authType, onChange: (event) => setAuthType(event.target.value) }, [
          h('option', { value: 'password' }, t('authPassword')),
          h('option', { value: 'key' }, t('authKey')),
        ]),
      ]),
    ]),
    authType === 'password'
      ? field(t('password'), password, setPassword, '••••••••', { type: 'password' })
      : h(Fragment, null, [
          h('label', { className: 'ssh-field' }, [
            h('span', { className: 'ssh-field-label' }, t('privateKey')),
            h('textarea', {
              className: 'ssh-input ssh-textarea', value: privateKey, spellCheck: false,
              placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
              onChange: (event) => setPrivateKey(event.target.value),
            }),
          ]),
          field(t('passphrase'), passphrase, setPassphrase, ''),
        ]),
    (error || localError) ? h('div', { className: 'ssh-alert' }, error ?? localError) : null,
    h('div', { className: 'ssh-form-actions' }, [
      h('button', { type: 'button', className: 'ssh-btn', disabled: busy, onClick: onCancel }, t('cancel')),
      showSaveAndConnect && initial === undefined
        ? h(Fragment, null, [
            h('button', { type: 'button', className: 'ssh-btn', disabled: busy, onClick: () => submit(false) }, t('save')),
            h('button', { type: 'button', className: 'ssh-btn ssh-btn-primary', disabled: busy, onClick: () => submit(true) }, busy ? '\u2026' : t('saveAndConnect')),
          ])
        : h('button', { type: 'button', className: 'ssh-btn ssh-btn-primary', disabled: busy, onClick: () => submit(false) }, busy ? '\u2026' : submitLabel),
    ]),
  ]);
}

// ---- settings page: connection management -------------------------------------

function ConnectionsSettings({ t }) {
  const records = useStore(store, (s) => s.records);
  const wsConnected = useStore(store, (s) => s.wsConnected);

  useEffect(() => {
    openWs();
  }, []);

  return h('div', { className: 'ssh-settings' }, [
    h('header', { className: 'ssh-settings-header' }, [
      h('div', null, [
        h('span', { className: 'ssh-panel-kicker' }, 'dsh-ssh'),
        h('h2', null, t('settingsTitle')),
        h('p', null, t('settingsIntro')),
      ]),
      h('div', { className: 'ssh-settings-actions' }, [
        !wsConnected ? h('span', { className: 'ssh-ws-state', title: t('wsDisconnected') }, '\u25CF') : null,
        h('button', {
          type: 'button', className: 'ssh-btn ssh-btn-primary',
          onClick: () => store.set({ formOpen: true, editing: null }),
        }, t('newConnection')),
      ]),
    ]),
    h('div', { className: 'ssh-settings-list-title' }, t('connectionsList')),
    records.length === 0
      ? h('div', { className: 'ssh-list-empty' }, [
          h('p', null, t('emptyList')),
          h('p', null, t('emptyListAi')),
        ])
      : h('div', { className: 'ssh-settings-rows' },
          records.map((record) => h(SettingsRow, { key: record.name, t, record })),
        ),
    h('p', { className: 'ssh-settings-hint' }, t('settingsHint')),
    h(FormModal, { t }),
    h(TransferDialog, { t }),
    h(DeleteDialog, { t }),
  ]);
}

function SettingsRow({ t, record }) {
  const online = record.status === 'connected' || record.status === 'connecting';
  return h('div', { className: 'ssh-settings-row' }, [
    h('div', { className: 'ssh-settings-row-head' }, [
      h(StateDot, { state: statusTone(record.status), size: 9 }),
      h('span', { className: 'ssh-settings-row-name' }, record.name),
      h(SourceBadge, { source: record.source, t }),
      h('span', { className: 'ssh-status-text ssh-status-' + record.status }, statusText(t, record.status)),
    ]),
    h('div', { className: 'ssh-settings-row-meta' },
      `${record.user}@${record.host}:${record.port} · ${record.authType === 'password' ? t('authPassword') : t('authKey')}${record.busyBy ? ' · ' + (record.busyBy === 'ai' ? t('busyAi') : t('busyUser')) : ''}`),
    h('div', { className: 'ssh-settings-row-actions' }, [
      online
        ? h('button', { type: 'button', className: 'ssh-btn ssh-btn-mini', onClick: () => request('disconnect', { name: record.name }).catch((error) => flashError(error.message)) }, t('disconnect'))
        : h('button', { type: 'button', className: 'ssh-btn ssh-btn-mini ssh-btn-primary', onClick: () => request('connect', { name: record.name }).catch((error) => flashError(error.message)) }, t('connect')),
      h('button', { type: 'button', className: 'ssh-btn ssh-btn-mini', onClick: () => store.set({ formOpen: true, editing: record.name }) }, t('edit')),
      h('button', { type: 'button', className: 'ssh-btn ssh-btn-mini ssh-btn-danger', onClick: () => store.set({ deleteName: record.name }) }, t('delete')),
    ]),
  ]);
}

// ---- transfer / delete / close-tab confirmations ---------------------------------

function TransferDialog({ t }) {
  const transferName = useStore(store, (s) => s.transferName);
  const transferDone = useStore(store, (s) => s.transferDone);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!transferName) {
      setAck(false);
      setBusy(false);
    }
  }, [transferName]);

  if (!transferName) return null;
  const onConfirm = () => {
    setBusy(true);
    request('transferToAi', { name: transferName }).then((result) => {
      setBusy(false);
      if (result && result.error && !result.ok) {
        flashError(result.error);
        store.set({ transferName: null });
        return;
      }
      store.set({ transferDone: true, transferName: null });
      setTimeout(() => store.set({ transferDone: false }), 2000);
    }).catch((error) => {
      setBusy(false);
      flashError(error.message);
      store.set({ transferName: null });
    });
  };
  if (transferDone) {
    return h('div', { className: 'ssh-toast' }, t('transferDone'));
  }
  return h(RiskConfirmation, {
    open: true,
    title: t('transferTitle'),
    description: t('transferDesc'),
    acknowledgeLabel: t('transferAck'),
    cancelLabel: t('cancel'),
    confirmLabel: t('transferConfirm'),
    acknowledged: ack,
    disabled: busy,
    onAcknowledgedChange: setAck,
    onCancel: () => store.set({ transferName: null }),
    onConfirm,
  });
}

function DeleteDialog({ t }) {
  const deleteName = useStore(store, (s) => s.deleteName);
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (!deleteName) setAck(false);
  }, [deleteName]);
  if (!deleteName) return null;
  const onConfirm = () => {
    request('deleteRecord', { name: deleteName }).then((result) => {
      if (result && result.error && !result.ok) flashError(result.error);
      store.set({ deleteName: null });
    }).catch((error) => {
      flashError(error.message);
      store.set({ deleteName: null });
    });
  };
  return h(RiskConfirmation, {
    open: true,
    title: t('deleteTitle').replace('{name}', deleteName),
    description: t('deleteDesc'),
    acknowledgeLabel: t('deleteConfirm'),
    cancelLabel: t('cancel'),
    confirmLabel: t('deleteConfirm'),
    acknowledged: ack,
    onAcknowledgedChange: setAck,
    onCancel: () => store.set({ deleteName: null }),
    onConfirm,
  });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = `
.ssh-rail{position:fixed;right:0;top:42%;width:36px;height:92px;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-right:0;border-radius:12px 0 0 12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f7f5f1) 96%,transparent);box-shadow:-2px 2px 10px rgba(0,0,0,.08);z-index:50}
.ssh-rail-label{writing-mode:vertical-rl;font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--dsw-alias-fg-muted,#77736d)}
.ssh-panel{display:flex;flex-direction:column;height:100%;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-fg-primary,#26231f);overflow:hidden}
.ssh-panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e8e5df);flex:none}
.ssh-panel-kicker{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:#6758d4;font-weight:700}
.ssh-panel-title h2{font-size:14px;margin:2px 0 0;letter-spacing:-.01em}
.ssh-panel-actions{display:flex;align-items:center;gap:6px}
.ssh-ws-state{color:#c34f4f;font-size:14px}
.ssh-panel-body{flex:1;display:flex;min-height:0}
.ssh-main{flex:1;display:flex;flex-direction:column;min-width:0}
.ssh-tabs{display:flex;gap:4px;padding:6px 8px 0;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-subtle,#e8e5df);flex:none;align-items:flex-end}
.ssh-tabs-empty{padding:8px 4px 10px;color:var(--dsw-alias-fg-muted,#77736d);font-size:11px}
.ssh-tab{display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;cursor:pointer;background:transparent;max-width:190px;min-width:0}
.ssh-tab:hover{background:var(--dsw-alias-bg-layer-2,#f7f5f1)}
.ssh-tab-active{background:var(--dsw-alias-bg-layer-2,#f7f5f1);border-color:var(--dsw-alias-border-subtle,#dedbd5)}
.ssh-tab-name{font-weight:600;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssh-tab-close{border:0;background:transparent;color:var(--dsw-alias-fg-muted,#77736d);cursor:pointer;font-size:13px;line-height:1;padding:1px 3px;border-radius:4px}
.ssh-tab-close:hover{background:rgba(195,79,79,.12);color:#c34f4f}
.ssh-tabadd-wrap{position:relative;display:flex;align-items:center;flex:none;padding-bottom:1px}
.ssh-tab-add{width:24px;height:24px;border:1px dashed var(--dsw-alias-border-subtle,#c9c3d8);background:transparent;color:var(--dsw-alias-fg-muted,#77736d);border-radius:7px;cursor:pointer;font-size:15px;line-height:1;display:grid;place-items:center;padding:0}
.ssh-tab-add:hover{border-color:#6758d4;color:#6758d4;background:rgba(103,88,212,.08)}
.ssh-addtab-modal{width:520px}
.ssh-addtab-list{display:grid;gap:2px;max-height:200px;overflow-y:auto;padding:2px}
.ssh-addtab-section-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-fg-muted,#77736d);font-weight:700;padding:2px 4px 6px}
.ssh-addtab-divider{height:1px;background:var(--dsw-alias-border-subtle,#e8e5df);margin:8px 0 10px}
.ssh-tabmenu-item{display:flex;align-items:center;gap:7px;border:0;background:transparent;color:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;min-width:0;width:100%}
.ssh-tabmenu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f7f5f1)}
.ssh-tabmenu-item:disabled{opacity:.6;cursor:not-allowed}
.ssh-tabmenu-item-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.ssh-tabmenu-item-host{color:var(--dsw-alias-fg-muted,#77736d);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right}
.ssh-tabmenu-empty{padding:8px;color:var(--dsw-alias-fg-muted,#77736d);font-size:11px}
.ssh-transfer-strip{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(103,88,212,.25);background:rgba(103,88,212,.06);flex:none}
.ssh-transfer-strip-text{font-size:10.5px;color:var(--dsw-alias-fg-muted,#77736d);flex:1;min-width:0}
.ssh-terminal-wrap{flex:1;display:flex;flex-direction:column;min-height:0;padding:6px 10px 10px;gap:6px}
.ssh-term-header{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.ssh-term-header-name{font-weight:650}
.ssh-term-header-error{color:#c34f4f;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.ssh-term-header-busy{color:#d19a3a;font-size:10px;font-weight:650}
.ssh-status-text{font-size:10px;font-weight:650}
.ssh-status-connected{color:#2e9e5b}.ssh-status-connecting{color:#5a7fd4}.ssh-status-reconnecting{color:#d19a3a}.ssh-status-disconnected{color:#c34f4f}.ssh-status-error{color:#c34f4f}
.ssh-badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:999px;letter-spacing:.04em;flex:none}
.ssh-badge-ai{background:rgba(103,88,212,.14);color:#6758d4}
.ssh-badge-user{background:rgba(90,110,140,.14);color:#5a6e8c}
.ssh-badge-user-icon{font-size:9px}
.ssh-terminal-empty{flex:1;display:grid;place-items:center;color:var(--dsw-alias-fg-muted,#77736d);font-size:12px;padding:20px;text-align:center}
.ssh-terminal-wrap2{flex:1;display:flex;flex-direction:column;min-height:0;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:9px;background:#0e1116;overflow:hidden}
.ssh-terminal-scroll{flex:1;overflow-y:auto;padding:8px 10px;font-family:ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,Menlo,monospace;font-size:12px;line-height:1.5;color:#d7dce2;user-select:text;-webkit-user-select:text;white-space:pre-wrap;word-break:break-all}
.ssh-line{min-height:1.4em}
.ssh-line-marker{display:flex;gap:7px;align-items:baseline;margin-top:7px}
.ssh-source-tag{font-size:9px;font-weight:800;padding:1px 6px;border-radius:999px;flex:none}
.ssh-source-tag-ai{background:rgba(139,122,255,.22);color:#b9adff}
.ssh-source-tag-user{background:rgba(96,165,210,.2);color:#8fc3e8}
.ssh-marker-cmd{font-weight:700;color:#e8ecf2}
.ssh-line-end{color:#8b93a1;font-size:11px;margin-bottom:4px}
.ssh-line-notice{color:#c9a86a;font-style:italic;font-size:11px;margin:2px 0}
.ssh-terminal-wrap2{position:relative;display:flex;flex-direction:column;min-height:0;flex:1}
.ssh-terminal-wrap2:focus-within{box-shadow:inset 0 0 0 1px rgba(124,111,240,.5)}
.ssh-terminal-blocked{opacity:.82}
.ssh-terminal-catcher{position:absolute;inset:0;opacity:0;border:0;padding:0;margin:0;background:transparent;caret-color:transparent;outline:none;pointer-events:none;font-size:12px;font-family:ui-monospace,'Cascadia Code',Consolas,Menlo,monospace}
.ssh-term-cursor{display:inline-block;width:.58em;height:1.12em;margin-left:1px;background:#d7dce2;vertical-align:text-bottom;animation:ssh-blink 1.06s steps(1) infinite}
@keyframes ssh-blink{50%{opacity:0}}
.ssh-terminal-busy{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);font-size:10.5px;color:#d19a3a;background:rgba(30,28,24,.92);border:1px solid rgba(209,154,58,.45);border-radius:999px;padding:3px 10px;pointer-events:none;white-space:nowrap;z-index:3}
.ssh-input{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:inherit;padding:6px 8px;font:inherit;min-width:0}
.ssh-input:focus{outline:2px solid #7c6ff0;outline-offset:-1px}
.ssh-input:disabled{opacity:.55;cursor:not-allowed}
.ssh-textarea{min-height:74px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:11px}
.ssh-btn{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:7px;padding:5px 10px;font-size:11px;cursor:pointer}
.ssh-btn:hover:not(:disabled){border-color:#c9c3d8}
.ssh-btn:disabled{opacity:.5;cursor:not-allowed}
.ssh-btn-mini{padding:2px 7px;font-size:10px;border-radius:6px}
.ssh-btn-primary{background:#6758d4;border-color:#6758d4;color:#fff}
.ssh-btn-primary:hover:not(:disabled){background:#5b4ec2}
.ssh-btn-danger{color:#c34f4f}
.ssh-btn-transfer{color:#6758d4}
.ssh-btn-ghost{border-color:transparent;background:transparent}
.ssh-btn-ghost:hover{border-color:transparent;background:var(--dsw-alias-bg-layer-2,#f7f5f1)}
.ssh-collapse{font-size:15px;padding:2px 7px}
.ssh-modal-mask{position:fixed;inset:0;background:rgba(20,18,28,.45);display:grid;place-items:center;z-index:80;pointer-events:auto}
.ssh-modal{width:440px;max-width:92vw;max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.3)}
.ssh-modal h3{margin:0 0 12px;font-size:15px}
.ssh-form{display:grid;gap:9px}
.ssh-form-row{display:grid;grid-template-columns:1fr 1.6fr;gap:9px}
.ssh-field{display:grid;gap:4px}
.ssh-field-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-fg-muted,#77736d);font-weight:700}
.ssh-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.ssh-alert{background:rgba(205,72,72,.1);color:#aa3939;border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.45}
.ssh-error-banner{background:rgba(205,72,72,.1);color:#aa3939;border-radius:8px;padding:7px 10px;font-size:11px}
.ssh-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2e9e5b;color:#fff;padding:9px 18px;border-radius:999px;font-size:12px;font-weight:650;z-index:90;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.ssh-settings{display:grid;gap:12px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.ssh-settings-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 2px}
.ssh-settings-header h2{font-size:22px;letter-spacing:-.02em;margin:3px 0 6px}
.ssh-settings-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:12.5px;line-height:1.55}
.ssh-settings-actions{display:flex;align-items:center;gap:8px}
.ssh-settings-list-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-fg-muted,#77736d);font-weight:700;padding:0 2px}
.ssh-list-empty{padding:12px 10px;color:var(--dsw-alias-fg-muted,#77736d);font-size:11px;line-height:1.5}
.ssh-list-empty p{margin:0 0 6px}
.ssh-settings-rows{display:grid;gap:8px}
.ssh-settings-row{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:11px;padding:10px 12px;display:grid;gap:6px;background:var(--dsw-alias-bg-layer-1,#fff)}
.ssh-settings-row-head{display:flex;align-items:center;gap:8px;min-width:0}
.ssh-settings-row-name{font-weight:650;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ssh-settings-row-meta{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d);font-family:ui-monospace,Consolas,monospace}
.ssh-settings-row-actions{display:flex;gap:6px;flex-wrap:wrap}
.ssh-settings-hint{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d);margin:2px 0 0}
`;

function installStyles() {
  const id = '@jmcc-guo/dsh-ssh/client';
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`);
  if (existing !== null) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@jmcc-guo/dsh-ssh';
  style.dataset.pluginCss = id;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** Required client services. */
exports.inject = ['slots', 'locale', 'layout'];

/** Mount the SSH terminal column, the reopen rail, and the settings page. */
exports.apply = function apply(ctx) {
  ctx.effect(installStyles, 'dsh-ssh: styles');
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-ssh: locale');
  const t = ctx.locale.bind(NS);
  const origHandle = handleEvent;
  window.__dshSshHook = (message) => {
    window.__dshSshEvents.push({
      t: Date.now(),
      kind: message.event ?? 'reply',
      id: message.id ?? null,
      tabs: message.state ? message.state.tabs : undefined,
      n: message.entries ? message.entries.length : undefined,
    });
    if (window.__dshSshEvents.length > 60) window.__dshSshEvents.shift();
  };

  // Bootstrap the channel once so every surface (column, settings page)
  // shares one live state stream.
  openWs();

  // The SSH terminal column occupies the native `details` column ONLY while
  // the panel is open (registered on demand, disposed on close), so the
  // original right column (tool details) is restored untouched as soon as
  // the panel is closed. Opening the panel opens the column, closing it
  // closes the column and releases the slot.
  //
  // The layout store is (re)attached when the root layout entry mounts —
  // which can happen AFTER the panel auto-opens (e.g. the tab appears while
  // the landing page is still shown, then the conversation view mounts a
  // fresh store with details=0). While the panel is open we therefore
  // re-assert `openDetails` on a light interval; the action is a no-op when
  // the column is already open.
  const layout = ctx.get('layout');
  let detailsDisposer = null;
  let detailsRetryTimer = null;
  const stopDetailsRetry = () => {
    if (detailsRetryTimer !== null) {
      clearInterval(detailsRetryTimer);
      detailsRetryTimer = null;
    }
  };
  const syncDetails = () => {
    const open = store.get().panelOpen;
    if (open && detailsDisposer === null) {
      detailsDisposer = ctx.slots.register({
        name: 'details',
        priority: -1,
        inject: () => ({ t }),
      }, SshColumn);
      if (layout !== undefined) {
        const tryOpen = () => {
          try {
            layout.openDetails();
          } catch { /* layout entry not wired yet — retried on the next tick */ }
        };
        tryOpen();
        stopDetailsRetry();
        detailsRetryTimer = setInterval(tryOpen, 800);
      }
    } else if (!open && detailsDisposer !== null) {
      detailsDisposer();
      detailsDisposer = null;
      stopDetailsRetry();
      if (layout !== undefined) layout.closeDetails();
      // A closed panel forgets the session it was tied to, so the next open
      // in any session is treated as a fresh mount (no immediate close).
      store.set({ lastSessionId: null });
    }
  };
  ctx.slots.inject('details', () => {
    const unsub = store.subscribe(syncDetails);
    syncDetails();
    return () => {
      unsub();
      stopDetailsRetry();
      if (detailsDisposer !== null) {
        detailsDisposer();
        detailsDisposer = null;
      }
    };
  });

  // Right-edge rail shown while the column is closed.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-ssh-rail',
    order: 20,
    label: () => t('panelTitle'),
    inject: () => ({ t }),
  }, OverlayRail));

  // Settings page: connection + credential management.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-ssh',
    order: 25,
    label: () => t('settingsTitle'),
    inject: () => ({ t }),
  }, ConnectionsSettings));
};

return module.exports; } });
