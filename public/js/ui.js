/**
 * Tiny DOM helpers. All content is inserted as text nodes – never as HTML –
 * so mail subjects, chat lines etc. cannot inject markup.
 */
import { t } from './i18n.js';

const TRANSLATED_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : TRANSLATED_ATTRS.has(k) ? t(String(v)) : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(t(String(c), el.tagName)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function toast(message, kind = 'info', ms = 4000) {
  const t = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function modal(title, body, { actions = [] } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => clear(root);
  const backdrop = h(
    'div',
    { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h1', null, title), h('div', { class: 'toolbar' }, actions, h('button', { onclick: close, title: 'Close (Esc)' }, 'Close'))), body),
  );
  clear(root).appendChild(backdrop);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  return { close, el: backdrop };
}

export async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'ok', 2000);
  } catch {
    toast('Clipboard not available', 'error');
  }
}

export function codeBox(code) {
  return h('span', { class: 'code-box' }, code, h('button', { class: 'small', onclick: () => copy(code, 'Code copied') }, 'Copy'));
}

export function badge(status, text) {
  const map = { ok: 'ok', HEALTHY: 'ok', warn: 'warn', WARNING: 'warn', error: 'error', ERROR: 'error', skipped: 'skipped', unknown: 'unknown' };
  return h('span', { class: `badge ${map[status] ?? 'unknown'}` }, text ?? status);
}

/** Schedule note for a session: window text + whether it is waiting for the next window. */
export function scheduleNote(sess) {
  const sc = sess?.schedule;
  if (!sc) return null;
  const next = sc.nextChange ? new Date(sc.nextChange).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const text = sc.override ? `manual start – schedule resumes ${next ?? ''}` : sc.active ? `in window until ${next ?? '–'}` : `waiting for window (${next ?? '–'})`;
  return h('div', { class: 'muted', style: { fontSize: '12px' }, title: sc.text }, h('span', { class: 'tag' }, 'schedule'), text);
}

/** Small square state mark (text alternative in the title). */
export function statusIcon(status) {
  const cls = { ok: 'ok', warn: 'warn', error: 'error' }[status] ?? '';
  return h('span', { class: `mark ${cls}`, title: status, 'aria-label': status });
}

export function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const today = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString()} ${hm}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function identityName(row) {
  return row.label || `Identity${pad2(row.number)}`;
}

/** Reads all named inputs of a container into an object. */
export function formData(root) {
  const out = {};
  for (const el of root.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function field(label, input) {
  return h('label', { class: 'field' }, label, input);
}

export function select(name, options, value, attrs = {}) {
  return h(
    'select',
    { name, ...attrs },
    options.map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value ?? '') }, t);
    }),
  );
}

export function openExternal(url) {
  // window.open(..., 'noopener') always returns null – a link click opens reliably without that ambiguity
  const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    if (!e?.silent && !window.__hoelniLeaving) toast(e.message || String(e), 'error', 7000);
    return undefined;
  }
}

/** Replaces an element's children (arrays are flattened, text is escaped). */
export function mount(el, ...children) {
  clear(el);
  append(el, children);
  el.__editedAt = 0; // fresh content: nothing unsaved
  trackEdits(el);
  return el;
}

/**
 * Like mount, but keeps every child that did not change (same markup): a live update then only swaps
 * what really changed instead of rebuilding the whole view (no jumping, no reloaded images, scroll
 * position and hover stay). Children with data-key are matched by key, others by position.
 */
export function patch(el, ...children) {
  const tmp = document.createElement(el.tagName);
  append(tmp, children);
  const next = [...tmp.childNodes];
  const old = [...el.childNodes];
  const byKey = new Map(old.filter((n) => n.nodeType === 1 && n.dataset.key).map((n) => [n.dataset.key, n]));
  const result = next.map((n, i) => {
    const prev = n.nodeType === 1 && n.dataset.key ? byKey.get(n.dataset.key) : old[i];
    if (!prev || prev.nodeType !== n.nodeType || prev.nodeName !== n.nodeName) return n;
    if (prev.isEqualNode(n)) return prev;
    // same element, different content: patch its children (tables: tbody rows keep their DOM)
    if (n.nodeType === 1 && (n.tagName === 'TABLE' || n.tagName === 'TBODY' || n.tagName === 'THEAD') && sameAttributes(prev, n)) {
      patch(prev, ...n.childNodes);
      return prev;
    }
    return n;
  });
  if (result.length !== old.length || result.some((n, i) => n !== old[i])) el.replaceChildren(...result);
  return el;
}

function sameAttributes(a, b) {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const at of a.attributes) if (b.getAttribute(at.name) !== at.value) return false;
  return true;
}

/** Remembers when the user last changed an input inside el (see whenIdle). */
function trackEdits(el) {
  if (el.__editTracked) return;
  el.__editTracked = true;
  const mark = () => (el.__editedAt = Date.now());
  el.addEventListener('input', mark, true);
  el.addEventListener('change', mark, true);
}

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select';

/**
 * Live views re-render on events (session state, stats …). That must never throw away what the user
 * is typing or has changed but not saved yet: fn runs once nobody edits in root (no focused input,
 * no unsaved change in the last 2 minutes). Saving re-renders through mount(), which clears the mark.
 */
export function whenIdle(root, fn) {
  trackEdits(root);
  const busy = () => {
    const a = document.activeElement;
    return (a && root.contains(a) && a.matches(EDITABLE)) || (root.__editedAt && Date.now() - root.__editedAt < 120_000);
  };
  clearInterval(root.__idleTimer);
  if (!busy()) return fn();
  root.__idleTimer = setInterval(() => {
    if (!root.isConnected) return clearInterval(root.__idleTimer);
    if (busy()) return;
    clearInterval(root.__idleTimer);
    fn();
  }, 1000);
}

/** Runs fn once the modal root becomes empty (dialog closed). */
export function whenModalClosed(fn) {
  const root = document.getElementById('modal-root');
  if (!root.childElementCount) return fn();
  const obs = new MutationObserver(() => {
    if (!root.childElementCount) {
      obs.disconnect();
      fn();
    }
  });
  obs.observe(root, { childList: true });
}

// ---------------------------------------------------------------- status & formatting helpers

const STATE_CLASS = {
  ONLINE: 'ok', STARTING: 'info', CONNECTING: 'info', AUTHENTICATING: 'info', STOPPING: 'skipped',
  RECONNECTING: 'warn', BLOCKED: 'error', STOPPED: 'skipped',
};
const STATE_HELP = {
  ONLINE: 'Connected and spawned',
  STARTING: 'Preflight checks (network guard, auth)',
  CONNECTING: 'Opening the connection',
  AUTHENTICATING: 'Logging in',
  STOPPING: 'Disconnecting',
  RECONNECTING: 'Should be online – waiting for the next attempt (backoff)',
  BLOCKED: 'Should be online, but the reconnect policy forbids automatic retries – fix the cause and start again',
  STOPPED: 'Not running',
};

export function stateBadge(state, extra) {
  return h('span', { class: `badge ${STATE_CLASS[state] ?? 'unknown'}`, title: (STATE_HELP[state] ?? state) + (extra ? `\n${extra}` : '') }, state);
}

export function relTime(iso) {
  if (!iso) return '–';
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(diff);
  const s = a < 60 ? `${Math.round(a)}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return diff > 0 ? `in ${s}` : `${s} ago`;
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Tiny SVG sparkline. */
export function sparkline(values, { w = 160, h = 36, max } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('class', 'spark');
  if (!values.length) return svg;
  const m = max ?? Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 2) + 1},${h - 1 - (v / m) * (h - 4)}`).join(' ');
  const pl = document.createElementNS(ns, 'polyline');
  pl.setAttribute('points', pts);
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', 'currentColor');
  pl.setAttribute('stroke-width', '1.5');
  svg.appendChild(pl);
  return svg;
}

let openMenu = null;
/** Context menu at the mouse position. items: [label, fn] | null (separator). */
export function contextMenu(ev, items) {
  ev.preventDefault();
  if (openMenu) openMenu.remove();
  const menu = h(
    'div',
    { class: 'ctx-menu', style: { left: `${ev.clientX}px`, top: `${ev.clientY}px` } },
    items.map((it) =>
      it === null
        ? h('div', { class: 'ctx-sep' })
        : h('div', { class: `ctx-item ${it[2] ?? ''}`, onclick: () => { menu.remove(); openMenu = null; it[1](); } }, it[0]),
    ),
  );
  document.body.appendChild(menu);
  openMenu = menu;
  const r = menu.getBoundingClientRect();
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
  if (r.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  setTimeout(() => document.addEventListener('click', () => { menu.remove(); if (openMenu === menu) openMenu = null; }, { once: true }));
}

/**
 * "Open game": starts (or brings to the front) the real Minecraft client for the session.
 * The game is a normal desktop window – reachable with Alt-Tab like any other program.
 */
/**
 * "Open game". method 'stable': the game signs in with the identity's own login (the AFK session
 * steps aside for a moment and comes back when the game is closed) – nothing relayed in between.
 */
export async function openGame(api, sessionId, method = 'auto') {
  const r = await guard(() => api.post(`/api/sessions/${encodeURIComponent(sessionId)}/game`, { method }));
  if (!r) return r;
  const st = r.game?.status;
  toast(st === 'running' ? 'Game window brought to the front' : st === 'installing' ? 'Installing Minecraft – the game window opens when it is ready' : 'Minecraft is starting – the game window opens in a moment', 'ok');
  return r;
}

/** "Back to AFK": closes (handover mode) or minimizes (background mode) the game window. */
export async function closeGame(api, sessionId) {
  const r = await guard(() => api.del(`/api/sessions/${encodeURIComponent(sessionId)}/game`));
  if (r) toast('Back to AFK', 'ok');
  return r;
}

/** Small indicator for a session held by the real game client. */
export function gameBadge(sess) {
  const g = sess?.game;
  const active = g && !['closed', 'failed'].includes(g.status);
  if (!active && sess?.runtime !== 'game') return g?.status === 'failed' && g.message ? h('span', { class: 'game-tag', style: { borderColor: 'var(--err)', color: 'var(--err)' }, title: g.message }, 'game failed') : null;
  const pct = g?.progress && g.progress.total ? ` ${Math.floor((g.progress.done / g.progress.total) * 100)}%` : '';
  if (sess?.takeover === 'attached') return h('span', { class: 'game-tag live', title: 'The real game plays on this session\'s live connection (no re-login)' }, `in game${g && !g.visible ? ' · minimized' : ''}`);
  const label = sess?.runtime === 'game'
    ? (!g || g.status === 'running' ? (g && !g.visible ? 'game (minimized)' : 'game') : g.status)
    : g.status === 'running' ? 'joining…' : `${g.status}${pct}…`;
  return h('span', { class: `game-tag${sess?.runtime === 'game' ? ' live' : ''}`, title: g?.message ?? 'Held by the real Minecraft client' }, label === 'game' ? 'in game' : label);
}
