/*
 * Hoelni Control – steers the Hoelni Client Suite of the account from a phone or any browser.
 *
 *   app ──REST /api/remote/rpc──▶ backend ──relay──▶ the ACTIVE PC's suite (allowlist there)
 *   app ◀──/api/remote/events (live)── backend ◀── active PC
 *
 * Served by the backend at /app (same origin as the API); inside the Android app "Hoelni Control"
 * the page also gets a small bridge (window.HoelniControl) for the home-screen widgets.
 */
'use strict';
(() => {
  const bridge = window.HoelniControl || null;
  const STORE = 'hoelni.control';
  let session = load();
  let tab = 'home';
  let status = null; // { user, active, pcs }
  let cache = {}; // per view
  const feed = [];
  let liveAbort = null;
  let live = false;
  let refreshTimer = null;

  // ------------------------------------------------------------------ theme (light / dark like the system, or chosen)
  const THEME_KEY = 'hoelni.theme';
  const themePref = () => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  };
  function systemDark() {
    try {
      if (bridge && typeof bridge.isDarkMode === 'function') return !!bridge.isDarkMode();
    } catch {
      /* older app */
    }
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function applyTheme() {
    const pref = themePref();
    const dark = pref === 'dark' || (pref === 'system' && systemDark());
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#ffffff');
    try {
      if (bridge && typeof bridge.setTheme === 'function') bridge.setTheme(dark);
    } catch {
      /* older app */
    }
  }
  window.addEventListener('hoelni-theme', applyTheme);
  applyTheme();
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  } catch {
    /* old browser */
  }
  document.addEventListener('visibilitychange', () => !document.hidden && applyTheme());

  // ------------------------------------------------------------------ helpers
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || 'null');
    } catch {
      return null;
    }
  }
  function save(s) {
    session = s;
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify(s));
      else localStorage.removeItem(STORE);
    } catch {
      /* private mode */
    }
    try {
      if (bridge) s ? bridge.saveSession(location.origin, s.token, s.user) : bridge.clearSession();
    } catch {
      /* older app */
    }
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  /** replaceChildren with the same rules as h(): arrays flattened, null / false skipped. */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
    return el;
  }
  const ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    sessions: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M17 14.5c2.4.2 4 1.8 4.5 4.5"/>',
    macro: '<path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="M11 7.5h4.5a2 2 0 0 1 2 2V13M13 16.5H8.5a2 2 0 0 1-2-2V11"/>',
    chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L3 9M4 13a8 8 0 0 0 14.6 4.5L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    reconnect: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    updown: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
    chevdown: '<path d="M6 9l6 6 6-6"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICON[name]; // fixed markup from ICON above, never user data
    return svg;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const timeOf = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  function toast(text, kind = '') {
    const t = h('div', { class: `toast ${kind}` }, text);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), 3200);
  }
  const STATE = {
    ONLINE: ['ok', 'online'], STARTING: ['info', 'startet'], CONNECTING: ['info', 'verbindet'], AUTHENTICATING: ['info', 'meldet an'],
    RECONNECTING: ['warn', 'verbindet neu'], BLOCKED: ['err', 'blockiert'], STOPPING: ['', 'stoppt'], STOPPED: ['', 'offline'],
  };
  const stateOf = (s) => STATE[s] || ['', String(s || '').toLowerCase()];

  // ------------------------------------------------------------------ API
  async function call(path, init) {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.token}`, ...(init?.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) {
      signOut(true);
      throw new Error('Abgemeldet – bitte neu anmelden');
    }
    if (!r.ok) throw Object.assign(new Error(body.error || `Fehler ${r.status}`), { status: r.status });
    return body;
  }
  /** A request for the active PC (same paths as the suite's own interface). */
  const pc = (method, path, body) => call('/api/remote/rpc', { method: 'POST', body: JSON.stringify({ method, path, body }) });
  async function act(fn, ok) {
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      setTimeout(() => refresh(true), 400);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ------------------------------------------------------------------ live events
  function startLive() {
    stopLive();
    const ctrl = new AbortController();
    liveAbort = ctrl;
    fetch('/api/remote/events', { headers: { authorization: `Bearer ${session.token}` }, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok || !r.body) throw new Error('no stream');
        live = true;
        paintTop();
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) if (p.startsWith('data: ')) onEvent(JSON.parse(p.slice(6)));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        live = false;
        paintTop();
        if (liveAbort === ctrl && session) setTimeout(() => liveAbort === ctrl && startLive(), 5000);
      });
  }
  function stopLive() {
    const c = liveAbort;
    liveAbort = null;
    c?.abort();
  }
  function onEvent(ev) {
    if (ev.type === 'session.state' && ev.data) {
      const s = ev.data;
      feed.unshift({ at: new Date().toISOString(), text: `${s.username || s.id} @ ${s.serverName || ''}: ${stateOf(s.state)[1]}` });
    } else if (ev.type === 'macro' && ev.data && ev.data.status !== 'log') feed.unshift({ at: new Date().toISOString(), text: `Makro #${ev.data.macroId}: ${ev.data.status}${ev.data.message ? ` – ${ev.data.message}` : ''}` });
    else if (ev.type === 'auth.devicecode' && ev.data) toast(`Microsoft-Anmeldung: Code ${ev.data.userCode} auf ${ev.data.verificationUri}`);
    else if (ev.type === 'stars.alert' && ev.data) {
      const a = ev.data;
      const text = `${alertTitle(a)}: ${a.textDe}`;
      feed.unshift({ at: a.ts, text });
      toast(text, 'warn');
      // in a normal browser (not the Android app, which notifies by itself) a system notification, if allowed
      try {
        if (!window.HoelniControl && 'Notification' in window && Notification.permission === 'granted') new Notification('Hoelni – Sterne', { body: text, tag: a.id });
      } catch {
        /* not supported */
      }
    }
    feed.splice(30);
    if (ev.type === 'session.chat' && ev.data) {
      if (openChat && ev.data.sessionId === openChat.id) openChat.add(ev.data);
      if (cache.chat) {
        cache.chat.push(ev.data);
        cache.chat.splice(0, Math.max(0, cache.chat.length - 400));
        if (tab === 'chat' && chatView) chatView.add(ev.data);
      }
    }
    if (['session.state', 'identity.changed', 'macro', 'reward.changed', 'pcs.changed', 'stars.alert'].includes(ev.type)) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh(true), 600);
    }
  }

  // ------------------------------------------------------------------ shell
  const app = document.getElementById('app');
  let topEl = null;
  let mainEl = null;
  // big text tabs at the top (like "Portfolio  Cash"); the avatar opens "Mehr"
  const TABS = [['home', 'Portfolio'], ['sessions', 'Sessions'], ['chat', 'Chat']];
  function shell() {
    topEl = h('header', { class: 'tb' });
    mainEl = h('main');
    const dock = h('div', { class: 'dock' },
      h('button', { onclick: () => searchSheet() }, 'Suche', icon('search')),
      h('button', { onclick: () => actionsSheet() }, 'Aktionen', icon('updown')));
    app.replaceChildren(topEl, mainEl, dock);
    paintTop();
  }
  let busy = false;
  function paintTop() {
    if (!topEl) return;
    const active = status?.active;
    const user = status?.user?.username || session?.user || '';
    topEl.replaceChildren(
      h('div', { class: 'tabs' }, TABS.map(([id, label]) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; shell(); refresh(); } }, label))),
      h('button', { class: 'me', title: active ? `${active.name}${live ? ' · live' : ''}` : 'kein PC aktiv', onclick: () => { tab = 'more'; shell(); refresh(); } }, (user.slice(0, 1) || 'H').toUpperCase(), h('i', { class: active ? (live ? 'ok' : '') : 'err' })));
  }

  /** "Suche": identities and sessions by name. */
  function searchSheet() {
    const input = h('input', { placeholder: 'Identität, Spieler oder Server', autocomplete: 'off' });
    const out = h('div', { class: 'list' });
    const run = async () => {
      const q = input.value.trim().toLowerCase();
      if (!cache.pf) cache.pf = await pc('GET', `/api/stars/portfolio?range=${pfRange}`).catch(() => null);
      const ids = (cache.pf?.identities || []).filter((r) => !q || `${r.name} ${r.label || ''} ${r.online.join(' ')}`.toLowerCase().includes(q));
      fill(out, ids.length ? ids.map((r) => stockRow(r, () => { close(); identityPage(r.id); })) : h('div', { class: 'empty' }, 'Nichts gefunden.'));
    };
    input.addEventListener('input', () => void run());
    const close = sheet(h('div', { class: 'search' }, icon('search'), input), out);
    setTimeout(() => input.focus(), 50);
    void run();
  }

  /** "Aktionen": everything at once. */
  function actionsSheet() {
    const close = sheet(h('h2', null, 'Aktionen'),
      h('div', { class: 'big-actions' },
        h('button', { onclick: () => { close(); bulk('startSessions', 'Die Accounts gehen nacheinander online'); } }, 'Alle online', h('small', null, 'nacheinander, über Minuten')),
        h('button', { onclick: () => { if (confirm('Alle Sessions offline setzen? Die Accounts gehen nacheinander, über einige Minuten verteilt.')) { close(); bulk('stopSessions', 'Die Accounts gehen nacheinander offline'); } } }, 'Alle offline', h('small', null, 'nacheinander, über Minuten')),
        h('button', { onclick: () => { close(); bulk('reconnect', 'Neu verbinden…'); } }, 'Alle neu verbinden', h('small', null, 'sofort')),
        h('button', { onclick: () => { close(); refresh(); } }, 'Aktualisieren', h('small', null, status?.active ? status.active.name : ''))));
  }

  async function refresh(quiet) {
    if (!session || !mainEl) return;
    busy = !quiet;
    paintTop();
    try {
      status = await call('/api/remote/status');
      if (!status.active) {
        cache = {};
        paint();
        return;
      }
      if (tab === 'home') [cache.summary, cache.pf] = await Promise.all([pc('GET', '/api/summary'), pc('GET', `/api/stars/portfolio?range=${pfRange}`).catch(() => null)]);
      if (tab === 'people') cache.pf = await pc('GET', `/api/stars/portfolio?range=${pfRange}`).catch(() => cache.pf || null);
      if (tab === 'sessions' || tab === 'home' || tab === 'chat') cache.sessions = await pc('GET', '/api/sessions');
      if (tab === 'people' || tab === 'sessions' || !cache.rows) cache.rows = (await pc('GET', '/api/dashboard')).rows;
      if (tab === 'chat') cache.chat = await pc('GET', '/api/chat?limit=200');
      if (tab === 'macro') cache.macros = await pc('GET', '/api/macros');
      if (tab === 'more') [cache.agents, cache.ips] = await Promise.all([pc('GET', '/api/backend/agents').catch(() => []), pc('GET', '/api/public-ips').catch(() => null)]);
      cache.error = null;
      try {
        bridge?.refreshWidgets();
      } catch {
        /* older app */
      }
    } catch (e) {
      cache.error = e.message;
    } finally {
      busy = false;
      paintTop();
      paint();
    }
  }

  function paint() {
    if (!mainEl) return;
    const views = { home: viewHome, sessions: viewSessions, chat: viewChat, people: viewPeople, macro: viewMacros, more: viewMore };
    const parts = [];
    if (cache.error) parts.push(h('div', { class: 'banner err' }, cache.error));
    if (status && !status.active && tab !== 'more') {
      parts.push(h('div', { class: 'card empty' },
        h('div', { style: { fontSize: '40px' } }, '⏻'),
        h('p', null, h('b', null, 'Gerade ist kein PC aktiv.')),
        h('p', { class: 'small' }, 'Starte die Hoelni Client Suite auf einem PC, der mit diesem Konto angemeldet ist – dann steuerst du ihn hier.')));
    } else parts.push(views[tab]());
    mainEl.replaceChildren(...parts);
  }

  // ------------------------------------------------------------------ views
  // ------------------------------------------------------------------ portfolio look
  // Stars are shown like a broker app shows money: the balance over time as a price chart, every
  // identity as a "share" with its balance and its change over the chosen range.
  const RANGES = [['1d', '1T', 'Heute'], ['1w', '1W', '1 Woche'], ['1m', '1M', '1 Monat'], ['1y', '1J', '1 Jahr'], ['max', 'Max', 'Gesamt']];
  let pfRange = (() => {
    try {
      const v = localStorage.getItem('hoelni.range');
      return RANGES.some((r) => r[0] === v) ? v : '1d';
    } catch {
      return '1d';
    }
  })();
  function setRange(v) {
    pfRange = v;
    try {
      localStorage.setItem('hoelni.range', v);
    } catch {
      /* private mode */
    }
  }
  // avatar fill per identity (follows the identity, not its rank in the list)
  const AVA = ['#5856d6', '#0e8f82', '#c0504d', '#b7791f', '#3478c6', '#8e44ad', '#2f855a', '#b03a68'];
  const avaColor = (id) => AVA[Math.abs(Number(id) || 0) % AVA.length];
  const initials = (name) => (String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '');
  const pctNum = (p) => Math.abs(p).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** "▲ 150 ★ (1,23 %)" */
  // a percent from a tiny start value says nothing (0 → 2 stars …): then only the stars
  const pctOk = (p) => p !== null && p !== undefined && Math.abs(p) < 1000;
  const changeLong = (c, p) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${fmtNum(Math.abs(c))} ★${pctOk(p) ? ` (${pctNum(p)} %)` : ''}`;
  /** list column: "▲ 1,23 %" or, without a start value, "▲ 12 ★" */
  const changeShort = (c, p) => (c === 0 ? '0,00 %' : !pctOk(p) ? `${fmtNum(Math.abs(c))} ★` : `${pctNum(p)} %`);
  function pointTime(iso, range) {
    const d = new Date(iso);
    if (range === '1d') return `${pad2(d.getHours())}:${pad2(d.getMinutes())} Uhr`;
    if (range === '1w') return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}, ${pad2(d.getHours())}:00`;
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Smooth path through the points without overshooting (monotone cubic). */
  function smoothPath(pts) {
    const n = pts.length;
    if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const d = [];
    const m = [];
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1));
    m.push(d[0]);
    for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const sq = a * a + b * b;
      if (sq > 9) {
        const t = 3 / Math.sqrt(sq);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    let out = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h3 = (pts[i + 1][0] - pts[i][0]) / 3;
      out += `C${(pts[i][0] + h3).toFixed(1)},${(pts[i][1] + m[i] * h3).toFixed(1)} ${(pts[i + 1][0] - h3).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h3).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return out;
  }

  function axisTime(iso, range) {
    const d = new Date(iso);
    if (range === '1d') return `${pad2(d.getHours())}:00`;
    if (range === '1w') return d.toLocaleDateString('de-DE', { weekday: 'short' });
    if (range === '1m') return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
    return d.toLocaleDateString('de-DE', { month: 'short' });
  }

  /** Price curve (one series): dotted base line at the start, % labels on the right, times below; drag to read. */
  function trChart(points, cls, onScrub, range) {
    const wrap = h('div', { class: 'tr-chart', role: 'img', 'aria-label': 'Verlauf des Sterne-Stands' });
    if (!points || points.length < 2) return wrap;
    const W = 1000;
    const HGT = 220;
    const PAD = 16;
    const start = points[0].v;
    let min = Math.min(...points.map((p) => p.v));
    let max = Math.max(...points.map((p) => p.v));
    if (max === min) {
      max += 1;
      min -= 1;
    }
    const x = (i) => (i / (points.length - 1)) * W;
    const y = (v) => PAD + (1 - (v - min) / (max - min)) * (HGT - 2 * PAD);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${HGT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const base = document.createElementNS(NS, 'line');
    for (const [k, v] of Object.entries({ x1: 0, x2: W, y1: y(start), y2: y(start), class: 'base' })) base.setAttribute(k, String(v));
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', `line ${cls}`);
    // the curve is drawn through at most ~40 points (smooth like a price chart); reading stays exact
    const stepK = Math.max(1, Math.ceil(points.length / 40));
    const shown = points.map((p, i) => [x(i), y(p.v), i]).filter((q) => q[2] % stepK === 0 || q[2] === points.length - 1);
    line.setAttribute('d', smoothPath(shown));
    svg.append(base, line);
    wrap.append(svg);
    // quiet axis labels: change against the start in % (or stars when it started at 0), four steps
    for (let k = 0; k < 4; k++) {
      const v = max - ((max - min) * k) / 3;
      const text = start > 0 ? `${((v - start) / start * 100).toLocaleString('de-DE', { maximumFractionDigits: Math.abs((v - start) / start * 100) < 10 ? 2 : 1 })} %` : `${fmtNum(Math.round(v))} ★`;
      wrap.append(h('div', { class: 'ylab', style: { top: `${y(v)}px` } }, text));
    }
    wrap.append(h('div', { class: 'xlabs' }, [0, 1, 2, 3, 4].map((k) => h('span', null, axisTime(points[Math.round((k / 4) * (points.length - 1))].t, range)))));
    const cross = h('div', { class: 'cross' });
    const knob = h('div', { class: 'knob' });
    wrap.append(cross, knob);
    const at = (clientX) => {
      const r = wrap.getBoundingClientRect();
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((clientX - r.left) / r.width) * (points.length - 1))));
      const left = `${(x(i) / W) * 100}%`;
      cross.style.left = left;
      knob.style.left = left;
      knob.style.top = `${y(points[i].v)}px`;
      wrap.classList.add('scrub');
      onScrub(points[i]);
    };
    const end = () => {
      wrap.classList.remove('scrub');
      onScrub(null);
    };
    wrap.addEventListener('pointerdown', (e) => at(e.clientX));
    wrap.addEventListener('pointermove', (e) => (e.pointerType === 'mouse' || wrap.classList.contains('scrub')) && at(e.clientX));
    wrap.addEventListener('pointerleave', end);
    wrap.addEventListener('pointerup', (e) => e.pointerType !== 'mouse' && end());
    wrap.addEventListener('pointercancel', end);
    return wrap;
  }

  /** Big balance, change over the range, price line and range switch. */
  function priceBlock(label, value, series, range, onRange) {
    const cls = dir(series.change);
    const valueEl = h('div', { class: 'pf-value' }, fmtNum(value), h('small', null, '★'));
    // (the star stands where a broker app shows the currency)
    const when = RANGES.find((r) => r[0] === range)?.[2] || '';
    const changeEl = h('div', { class: `pf-change ${cls}` });
    const showChange = () => fill(changeEl, h('span', { class: 'tri' }, arrow(series.change)), changeLong(series.change, series.changePct), h('span', { class: 'when' }, when));
    showChange();
    const chart = trChart(series.points, cls, (p) => {
      if (!p) {
        fill(valueEl, fmtNum(value), h('small', null, '★'));
        changeEl.className = `pf-change ${cls}`;
        showChange();
        return;
      }
      const start = series.points[0].v;
      const c = p.v - start;
      fill(valueEl, fmtNum(p.v), h('small', null, '★'));
      changeEl.className = `pf-change ${dir(c)}`;
      fill(changeEl, h('span', { class: 'tri' }, arrow(c)), changeLong(c, start > 0 ? (c / start) * 100 : null), h('span', { class: 'when' }, pointTime(p.t, range)));
    }, range);
    return h('div', { class: 'pf' },
      label ? h('div', { class: 'pf-label' }, label) : null,
      valueEl,
      changeEl,
      h('div', { class: 'ranges' }, RANGES.map(([id, short]) => h('button', { class: id === range ? 'on' : '', onclick: () => onRange(id) }, short))),
      chart);
  }

  /** "Logo" of an identity: its Minecraft head (falls back to initials on a colour of its own). */
  function logo(id, name, on) {
    const el = h('div', { class: `logo ${on ? 'on' : ''}`, style: { background: avaColor(id) } }, initials(name));
    if (/^[A-Za-z0-9_]{3,16}$/.test(name || '')) {
      const img = h('img', { alt: '', src: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/88`, loading: 'lazy' });
      img.addEventListener('load', () => { el.style.background = 'transparent'; fill(el, img); });
      img.addEventListener('error', () => img.remove());
    }
    return el;
  }

  /** One identity like a holding: head, name, where it is online; balance and change on the right. */
  function stockRow(r, onclick) {
    const on = r.online && r.online.length > 0;
    return h('div', { class: 'stock', onclick },
      logo(r.id, r.name, on),
      h('div', { class: 'main' }, h('div', { class: 'name' }, r.name), h('div', { class: 'meta' }, on ? r.online.join(', ') : 'offline')),
      h('div', { class: 'right' }, h('div', { class: 'val' }, `${fmtNum(r.stars)} ★`), h('div', { class: `chg ${dir(r.change)}` }, r.change ? h('span', { class: 'tri' }, arrow(r.change)) : null, changeShort(r.change, r.changePct))));
  }

  const kv = (label, value, cls) => h('div', { class: 'kvrow' }, h('span', null, label), h('b', { class: cls || null }, value));

  /** Range for the list ("Heute ⌄" like "Seit Kauf ⌄"). */
  function rangeSheet() {
    const close = sheet(h('h2', null, 'Zeitraum'),
      h('div', { class: 'group menu' }, RANGES.map(([id, , long]) => h('div', { class: 'kvrow', onclick: () => { close(); setRange(id); refresh(true); } }, h('span', null, long), h('b', null, id === pfRange ? '✓' : '')))));
  }

  function viewHome() {
    const s = cache.summary;
    if (!s) return h('div', { class: 'empty' }, 'Lädt…');
    const pf = cache.pf;
    const ids = pf ? pf.identities : [];
    const alerts = (s.starAlerts || []).length;
    const goTab = (t) => { tab = t; shell(); refresh(); };
    const mini = (label, value, onclick, cls) => h('button', { class: 'mini', onclick }, h('span', null, label), h('b', { class: cls || null }, value));
    return h('div', null,
      pf
        ? priceBlock('Sterne', pf.total, pf, pf.range, (v) => { setRange(v); refresh(true); })
        : h('div', { class: 'pf' }, h('div', { class: 'pf-label' }, 'Sterne'), h('div', { class: 'pf-value' }, fmtNum(s.stars), h('small', null, '★'))),
      h('div', { class: 'cards' },
        mini('Online', `${s.sessions.online} von ${s.sessions.wanted}`, () => goTab('sessions')),
        mini('Warnungen', String(alerts), () => alertsSheet(), alerts ? 'warn' : ''),
        mini('Probleme', String(s.sessions.problems), () => goTab('sessions'), s.sessions.problems ? 'warn' : ''),
        mini('Agents', String(s.agents.online), () => goTab('more')),
        mini('Makros', 'öffnen', () => goTab('macro'))),
      h('div', { class: 'h2' }, h('b', null, 'Identitäten'), h('button', { onclick: () => rangeSheet() }, RANGES.find((r) => r[0] === pfRange)?.[2] || 'Heute', icon('chevdown'))),
      ids.length ? h('div', { class: 'list' }, ids.map((r) => stockRow(r, () => identityPage(r.id)))) : h('div', { class: 'empty' }, 'Keine Identitäten.'),
      alerts ? alertsCard(s.starAlerts) : null,
      h('div', { class: 'h2' }, h('b', null, 'Aktivität'), h('button', { onclick: () => starsSheet() }, 'Statistik')),
      h('div', { class: 'feed' }, feed.length ? feed.slice(0, 8).map((f) => h('div', null, h('time', null, timeOf(f.at)), h('span', null, f.text))) : h('div', { class: 'muted' }, live ? 'Noch nichts Neues.' : 'Live-Verbindung wird aufgebaut…')));
  }

  /** Full page of one identity: balance as a price chart, figures, servers; "Online" / "Offline" like buy / sell. */
  function identityPage(id) {
    let range = pfRange;
    const head = h('div', null, h('div', { class: 'empty' }, 'Lädt…'));
    const servers = h('div');
    const dash = (cache.rows || []).find((x) => x.id === id);
    const firstName = dash ? dash.minecraft.username || dash.label : `#${id}`;
    const title = h('div', { class: 't' }, h('b', null, firstName), h('span', null, dash?.label || ''));
    let close = () => undefined;
    const go = (action, ok) => act(async () => {
      await pc('POST', '/api/bulk', { action, identityIds: [id] });
      await draw();
      await details();
    }, ok);
    const draw = async () => {
      try {
        const d = await pc('GET', `/api/stars/identity/${id}?range=${range}`);
        fill(title, h('b', null, d.name), h('span', null, d.online.length ? `online · ${d.online.join(', ')}` : 'offline'));
        fill(head,
          priceBlock(null, d.stars, d, range, (v) => { range = v; setRange(v); void draw(); }),
          h('div', { class: 'h2' }, h('b', null, 'Position')),
          h('div', { class: 'group' },
            kv('Sterne', `${fmtNum(d.stars)} ★`),
            kv('Gewonnen 24 h', `+${fmtNum(d.gained.h24)} ★`, d.gained.h24 ? 'up' : ''),
            kv('Gewonnen 7 Tage', `+${fmtNum(d.gained.d7)} ★`, d.gained.d7 ? 'up' : ''),
            kv('Gewonnen 30 Tage', `+${fmtNum(d.gained.d30)} ★`, d.gained.d30 ? 'up' : ''),
            kv('Status', d.online.length ? `online · ${d.online.join(', ')}` : 'offline', d.online.length ? 'up' : '')));
      } catch (e) {
        fill(head, h('div', { class: 'banner err' }, e.message));
      }
    };
    let details = async () => undefined;
    const row = dash || { id, label: '', number: 0, minecraft: {}, stars: 0, ready: false, health: '', sessions: [] };
    close = sheet({ page: true },
      h('div', { class: 'page-top' }, h('button', { class: 'back', 'aria-label': 'Zurück', onclick: () => close() }, icon('back')), h('div', { class: 'grow' })),
      h('div', { class: 'page-head' }, logo(id, firstName, false), title),
      head,
      servers,
      h('div', { class: 'sticky-pair' }, h('div', { class: 'pair' },
        h('button', { class: 'pill-btn', onclick: () => go('startSessions', 'Geht online') }, 'Online'),
        h('button', { class: 'pill-btn dark', onclick: () => go('stopSessions', 'Geht offline') }, 'Offline'))));
    details = personDetails(row, servers);
    void draw();
    void details();
    return close;
  }

  // ------------------------------------------------------------------ stars
  const fmtNum = (n) => Number(n || 0).toLocaleString('de-DE');
  // ------------------------------------------------------------------ star alerts
  const ALERT_KIND = { stall: 'Keine Sterne', spike: 'Ungewöhnlich viele Sterne', drop: 'Sterne verloren', test: 'Test' };
  const alertTitle = (a) => (a.kind === 'test' ? 'Test' : `${a.name}${a.server ? ` (${a.server})` : ''} – ${ALERT_KIND[a.kind] || a.kind}`);
  const alertRow = (a) => h('div', { class: 'alert-row' }, h('time', null, timeOf(a.ts)), h('div', null, h('b', null, alertTitle(a)), h('div', { class: 'muted small' }, a.textDe)));

  /** Warnings of the last 24 hours on the home tab. */
  function alertsCard(list) {
    return h('div', null,
      h('div', { class: 'h2' }, h('b', null, 'Warnungen'), h('button', { onclick: () => alertsSheet() }, 'Alle ›')),
      h('div', { class: 'alerts' }, list.slice(0, 3).map(alertRow)));
  }

  async function alertsSheet() {
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    sheet(h('h2', null, 'Stern-Warnungen'), body);
    const draw = async () => {
      const al = await pc('GET', '/api/stars/alerts');
      const on = h('input', { type: 'checkbox', checked: al.settings.enabled });
      on.addEventListener('change', () => act(() => pc('PUT', '/api/stars/alerts/settings', { enabled: on.checked }), on.checked ? 'Warnungen an' : 'Warnungen aus'));
      const phone = window.HoelniControl && typeof window.HoelniControl.notificationsAllowed === 'function';
      const allowed = phone ? window.HoelniControl.notificationsAllowed() : 'Notification' in window && Notification.permission === 'granted';
      fill(body,
        h('p', { class: 'muted small' }, 'Der PC vergleicht jeden Account, der online ist, mit seinem eigenen Tempo der letzten 7 Tage: kein Stern viel länger als sonst, ungewöhnlich viele Sterne in einer Stunde oder viele Sterne verloren. Neue Warnungen kommen als Benachrichtigung aufs Handy (die App prüft etwa alle 15 Minuten). Die Grenzen stellst du in der Suite unter Sterne ein.'),
        h('label', { class: 'switch-row' }, on, h('span', null, 'Warnungen an')),
        allowed
          ? h('div', { class: 'muted small' }, 'Benachrichtigungen sind erlaubt.')
          : h('button', { class: 'btn wide', onclick: async () => {
              if (phone) window.HoelniControl.requestNotifications();
              else if ('Notification' in window) await Notification.requestPermission();
              setTimeout(() => void draw(), 1500);
            } }, 'Benachrichtigungen erlauben'),
        h('button', { class: 'btn wide', style: { marginTop: '8px' }, onclick: () => act(async () => {
          await pc('POST', '/api/stars/alerts/test');
          if (phone && typeof window.HoelniControl.checkAlertsNow === 'function') window.HoelniControl.checkAlertsNow();
          await draw();
        }, 'Testwarnung gesendet') }, 'Testbenachrichtigung senden'),
        h('div', { class: 'section-title' }, 'Verlauf'),
        al.alerts.length ? al.alerts.slice(0, 30).map((a) => h('div', null, h('div', { class: 'muted small' }, new Date(a.ts).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })), alertRow(a))) : h('div', { class: 'muted small' }, 'Bisher keine Warnungen.'));
    };
    try {
      await draw();
    } catch (e) {
      fill(body, h('div', { class: 'banner err' }, e.message));
    }
  }

  async function starsSheet() {
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    sheet(h('h2', null, 'Sterne pro Identität'), body);
    try {
      const st = await pc('GET', '/api/stars');
      cache.stars = st;
      fill(body,
        h('div', { class: 'kv' },
          h('div', null, 'Alle Identitäten'), h('div', null, `${fmtNum(st.total)} ★`),
          h('div', null, 'Gerade online'), h('div', null, `${fmtNum(st.online)} ★`),
          h('div', null, 'Ausgegeben (30 Tage)'), h('div', null, `${fmtNum(st.spent.d30)} ★`)),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Identität'), h('th', null, 'Stand'), h('th', null, '24 h'), h('th', null, '7 T'), h('th', null, '30 T'))),
          h('tbody', null, st.perIdentity.map((i) => h('tr', null,
            h('td', null, h('span', { class: `dot ${i.online ? 'ok' : ''}` }), ' ', i.name),
            h('td', null, fmtNum(i.stars)),
            h('td', null, i.h24 ? `+${fmtNum(i.h24)}` : '–'),
            h('td', null, i.d7 ? `+${fmtNum(i.d7)}` : '–'),
            h('td', null, i.d30 ? `+${fmtNum(i.d30)}` : '–'))))),
        h('p', { class: 'muted small' }, 'Der Stand kommt aus dem Scoreboard rechts im Spiel (bzw. aus Chat-Meldungen, wenn der Server keins zeigt). Die erste Ablesung zählt nicht als gewonnen.'));
    } catch (e) {
      fill(body, h('div', { class: 'banner err' }, e.message));
    }
  }

  async function bulk(action, ok) {
    const rows = (await pc('GET', '/api/dashboard').catch(() => ({ rows: [] }))).rows;
    act(() => pc('POST', '/api/bulk', { action, identityIds: rows.map((r) => r.id) }), ok);
  }

  let sessionFilter = 'all';
  function viewSessions() {
    const list = cache.sessions || [];
    const groups = { all: list, online: list.filter((s) => s.state === 'ONLINE'), problem: list.filter((s) => ['BLOCKED', 'RECONNECTING'].includes(s.state)), off: list.filter((s) => s.state === 'STOPPED') };
    const chip = (id, label) => h('button', { class: sessionFilter === id ? 'on' : '', onclick: () => { sessionFilter = id; paint(); } }, `${label} (${groups[id].length})`);
    const shown = groups[sessionFilter];
    return h('div', null,
      h('div', { class: 'chips' }, chip('all', 'Alle'), chip('online', 'Online'), chip('problem', 'Probleme'), chip('off', 'Offline')),
      shown.length ? shown.map(sessionRow) : h('div', { class: 'card empty' }, 'Keine Sessions.'));
  }

  /** Player / identity name of a session (a session that is still connecting has no player name yet). */
  function nameOf(s) {
    if (s.username) return s.username;
    const r = (cache.rows || []).find((x) => String(x.id) === String(s.id).split(':')[0]);
    return r ? r.minecraft.username || r.label : `#${String(s.id).split(':')[0]}`;
  }

  function sessionRow(s) {
    const [cls, text] = stateOf(s.state);
    const name = nameOf(s);
    return h('div', { class: 'row', onclick: () => sessionSheet(s) },
      logo(String(s.id).split(':')[0], name, s.state === 'ONLINE'),
      h('div', { class: 'main' }, h('div', { class: 'name' }, name), h('div', { class: 'meta' }, s.serverName || '', s.agentId ? ' · Agent' : '', s.stats?.ping != null ? ` · ${s.stats.ping} ms` : '', s.leaveAt ? ` · geht um ${timeOf(s.leaveAt)}` : '')),
      h('span', { class: `pill ${cls}` }, text));
  }

  // ------------------------------------------------------------------ sheets
  let openChat = null;
  /** Bottom sheet; sheet({ page: true }, …) opens a full-screen page instead. */
  function sheet(...content) {
    const page = !!(content[0] && content[0].page === true && !(content[0] instanceof Node));
    if (page) content = content.slice(1);
    const root = document.getElementById('sheet-root');
    const close = () => {
      root.replaceChildren();
      openChat = null;
    };
    const bg = h('div', { class: 'sheet-bg', onclick: (e) => e.target === bg && close() }, h('div', { class: page ? 'sheet page' : 'sheet' }, page ? null : h('div', { class: 'grip' }), ...content));
    root.replaceChildren(bg);
    return close;
  }

  function sessionSheet(s) {
    const [cls, text] = stateOf(s.state);
    const online = s.desiredState === 'ONLINE' || ['ONLINE', 'CONNECTING', 'AUTHENTICATING', 'STARTING', 'RECONNECTING'].includes(s.state);
    const [identityId, serverId] = String(s.id).split(':');
    let close;
    const run = (fn, ok) => act(async () => { await fn(); close(); }, ok);
    const sbBox = h('div');
    close = sheet(
      h('h2', null, nameOf(s)),
      h('div', null, h('span', { class: `pill ${cls}` }, text), ' ', h('span', { class: 'muted small' }, s.serverName || '')),
      h('div', { class: 'kv' },
        h('div', null, 'Läuft auf'), h('div', null, s.agentId ? `Agent #${s.agentId}` : status.active.name),
        s.stats?.ping != null ? [h('div', null, 'Ping'), h('div', null, `${s.stats.ping} ms`)] : null,
        s.stats?.health != null ? [h('div', null, 'Leben / Hunger'), h('div', null, `${s.stats.health} / ${s.stats.food}`)] : null,
        s.onlineSince ? [h('div', null, 'Online seit'), h('div', null, new Date(s.onlineSince).toLocaleString('de-DE'))] : null,
        s.lastError ? [h('div', null, 'Letzter Fehler'), h('div', null, s.lastError)] : null),
      h('div', { class: 'btns' },
        online
          ? h('button', { class: 'btn danger', onclick: () => run(() => pc('POST', `/api/sessions/${s.id}/stop`), 'Session gestoppt') }, 'Stoppen')
          : h('button', { class: 'btn primary', onclick: () => run(() => pc('POST', `/api/identities/${identityId}/sessions/${serverId}/start`), 'Session startet') }, 'Starten'),
        online ? h('button', { class: 'btn', onclick: () => run(() => pc('POST', `/api/sessions/${s.id}/reconnect`), 'Verbindet neu') }, 'Neu verbinden') : null,
        s.runtime === 'game' || s.takeover !== 'none' ? h('button', { class: 'btn', onclick: () => run(() => pc('DELETE', `/api/sessions/${s.id}/game`), 'Zurück zu AFK') }, 'Zurück zu AFK') : null,
        h('button', { class: 'btn', onclick: () => chatSheet(s) }, 'Chat')),
      sbBox);
    // the sidebar as the player sees it – shows what the star recognition reads
    pc('GET', `/api/sessions/${s.id}/scoreboard`)
      .then((sb) => {
        if (!sb?.lines?.length) return;
        fill(sbBox, h('div', { class: 'section-title' }, 'Scoreboard', sb.title ? h('span', { class: 'muted small' }, sb.title) : null),
          h('div', { class: 'card feed' }, sb.lines.map((l) => h('div', null, h('span', null, l.text || ' '), l.hidden ? null : h('time', { style: { marginLeft: 'auto' } }, String(l.value))))));
      })
      .catch(() => undefined);
  }

  function chatSheet(s) {
    const box = h('div', { class: 'chat' }, h('div', { class: 'muted' }, 'Lädt…'));
    const input = h('input', { placeholder: 'Nachricht oder /befehl', enterkeyhint: 'send' });
    const line = (l) => h('div', null, h('time', null, timeOf(l.ts)), l.text);
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      pc('POST', `/api/sessions/${s.id}/chat`, { text }).catch((e) => toast(e.message, 'err'));
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
    sheet(h('h2', null, `Chat · ${nameOf(s)}`), h('div', { class: 'muted small' }, s.serverName || ''), box, h('div', { class: 'send' }, input, h('button', { class: 'btn primary', onclick: send }, 'Senden')));
    openChat = {
      id: s.id,
      add: (l) => {
        if (!l?.text) return;
        box.append(line(l));
        box.scrollTop = box.scrollHeight;
      },
    };
    pc('GET', `/api/sessions/${s.id}/chat?limit=80`)
      .then((lines) => {
        const list = Array.isArray(lines) ? lines : lines.lines || [];
        box.replaceChildren(...(list.length ? list.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).map(line) : [h('div', { class: 'muted' }, 'Noch kein Chat.')]));
        box.scrollTop = box.scrollHeight;
      })
      .catch((e) => box.replaceChildren(h('div', { class: 'muted' }, e.message)));
  }

  // ------------------------------------------------------------------ chat (all sessions)
  /** The chat tab is built once and kept, so a refresh never eats what is being typed. */
  let chatView = null;
  function viewChat() {
    if (!chatView) chatView = buildChat();
    chatView.update();
    return chatView.el;
  }
  function buildChat() {
    let filter = 'all';
    let target = 'online';
    const box = h('div', { class: 'chat chat-all' });
    const filterSel = h('select', { onchange: () => { filter = filterSel.value; render(); } });
    const targetSel = h('select', { onchange: () => { target = targetSel.value; } });
    const input = h('input', { placeholder: 'Nachricht oder /befehl', enterkeyhint: 'send', maxlength: '256' });
    const sendBtn = h('button', { class: 'btn primary' }, 'Senden');
    const online = () => (cache.sessions || []).filter((s) => s.state === 'ONLINE');
    const label = (s) => `${nameOf(s)} · ${s.serverName || ''}`;
    const sessionOf = (id) => (cache.sessions || []).find((s) => s.id === id);
    const visible = (l) => filter === 'all' || l.sessionId === filter;
    const line = (l) => {
      const s = sessionOf(l.sessionId);
      const who = s ? nameOf(s) : nameOf({ id: l.sessionId });
      return h('div', null, h('time', null, timeOf(l.ts)), filter === 'all' ? h('b', { class: 'who' }, who, s?.serverName ? h('span', { class: 'muted' }, ` @${s.serverName}`) : null) : null, l.text);
    };
    function render() {
      const list = (cache.chat || []).filter(visible);
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40 || !box.childElementCount;
      box.replaceChildren(...(list.length ? list.map(line) : [h('div', { class: 'muted' }, cache.chat ? 'Noch kein Chat.' : 'Lädt…')]));
      if (stick) box.scrollTop = box.scrollHeight;
    }
    function options(sel, first, value) {
      const list = cache.sessions || [];
      sel.replaceChildren(...first.map(([v, t]) => h('option', { value: v }, t)), ...list.map((s) => h('option', { value: s.id }, `${label(s)}${s.state === 'ONLINE' ? '' : ' (offline)'}`)));
      sel.value = [...sel.options].some((o) => o.value === value) ? value : first[0][0];
      return sel.value;
    }
    async function send() {
      const text = input.value.trim();
      if (!text) return;
      const ids = target === 'online' ? online().map((s) => s.id) : [target];
      if (!ids.length) return toast('Keine Session online', 'err');
      if (ids.length > 1 && !confirm(`An ${ids.length} Sessions senden?\n\n${text}`)) return;
      sendBtn.disabled = true;
      try {
        const r = await pc('POST', '/api/chat/send', { sessionIds: ids, text });
        const bad = (r.results || []).filter((x) => !x.ok);
        input.value = '';
        if (bad.length) toast(`${bad.length} von ${ids.length} nicht gesendet: ${bad[0].error}`, 'err');
        else toast(ids.length > 1 ? `An ${ids.length} Sessions gesendet` : 'Gesendet', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        sendBtn.disabled = false;
      }
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
    const el = h('div', null,
      h('div', { class: 'card chat-head' },
        h('label', null, h('span', { class: 'muted small' }, 'Anzeigen'), filterSel),
        h('label', null, h('span', { class: 'muted small' }, 'Senden an'), targetSel)),
      box,
      h('div', { class: 'send' }, input, sendBtn));
    return {
      el,
      update() {
        filter = options(filterSel, [['all', 'Alle Sessions']], filter);
        target = options(targetSel, [['online', `Alle online (${online().length})`]], target);
        render();
      },
      add(l) {
        if (!visible(l)) return;
        if (box.firstElementChild?.classList.contains('muted')) box.replaceChildren();
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.append(line(l));
        while (box.childElementCount > 400) box.firstElementChild.remove();
        if (stick) box.scrollTop = box.scrollHeight;
      },
    };
  }

  let peopleFilter = 'all';
  function viewPeople() {
    const pf = cache.pf;
    const list = pf ? pf.identities : (cache.rows || []).map((r) => ({ id: r.id, name: r.minecraft.username || r.label, stars: Number(r.stars) || 0, online: r.sessions.filter((x) => x.state === 'ONLINE').map((x) => x.serverName || ''), change: 0, changePct: null }));
    const groups = { all: list, online: list.filter((r) => r.online.length), off: list.filter((r) => !r.online.length) };
    const chip = (id, label) => h('button', { class: peopleFilter === id ? 'on' : '', onclick: () => { peopleFilter = id; paint(); } }, `${label} · ${groups[id].length}`);
    return h('div', null,
      h('div', { class: 'title-xl' }, 'Identitäten'),
      pf
        ? h('div', { class: `pf-change ${dir(pf.change)}` }, h('span', { class: 'tri' }, arrow(pf.change)), changeLong(pf.change, pf.changePct), h('span', { class: 'when' }, RANGES.find((r) => r[0] === pf.range)?.[2] || ''))
        : null,
      h('div', { class: 'seg-chips' }, chip('all', 'Alle'), chip('online', 'Online'), chip('off', 'Offline')),
      h('div', { class: 'ranges', style: { margin: '6px -6px 4px' } }, RANGES.map(([id, short]) => h('button', { class: pf && id === pf.range ? 'on' : '', onclick: () => { setRange(id); refresh(true); } }, short))),
      groups[peopleFilter].length ? h('div', { class: 'list' }, groups[peopleFilter].map((r) => stockRow(r, () => identityPage(r.id)))) : h('div', { class: 'empty' }, 'Keine Identitäten.'),
      h('div', { class: 'group menu', style: { marginTop: '24px' } },
        h('div', { class: 'kvrow', onclick: () => serversSheet() }, h('span', null, 'Server & Zuweisungen'), h('b', null, '›'))));
  }

  /** Where something runs: label of a placement / agent id. */
  function placeLabel(agents, agentId) {
    if (agentId === null || agentId === undefined) return status?.active?.name ? `PC „${status.active.name}“` : 'PC';
    const a = agents.find((x) => x.id === agentId);
    return a ? `Agent „${a.name}“${a.online ? (a.paused ? ' (pausiert)' : '') : ' (offline)'}` : `Agent #${agentId}`;
  }

  function select(options, value, onchange) {
    const el = h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(value) }, label)));
    return el;
  }

  /** Identity: servers with state, start / stop, where each runs (this PC or an agent), add / remove servers. */
  function personDetails(r, body) {
    const name = r.label || r.minecraft.username || `Identity${pad2(r.number)}`;
    fill(body, h('div', { class: 'muted small' }, 'Lädt…'));
    const reload = async () => {
      try {
        const [detail, servers, agents, rows] = await Promise.all([pc('GET', `/api/identities/${r.id}`), pc('GET', '/api/servers'), pc('GET', '/api/backend/agents').catch(() => []), pc('GET', '/api/dashboard').then((d) => d.rows)]);
        const row = rows.find((x) => x.id === r.id) || r;
        const identityAgent = detail.identity.settings.agentId ?? null;
        const agentOpts = agents.map((a) => [a.id, placeLabel(agents, a.id)]);
        const change = (fn, ok) => act(async () => { await fn(); await reload(); }, ok);
        const assigned = new Set(detail.assignments.map((a) => a.serverId));
        const free = servers.filter((x) => !assigned.has(x.id));
        fill(body, 
          h('div', { class: 'section-title' }, 'Läuft standardmäßig auf'),
          h('div', { class: 'card' },
            select([['', placeLabel(agents, null)], ...agentOpts], identityAgent ?? '', (v) =>
              change(() => pc('PUT', `/api/identities/${r.id}`, { settings: { agentId: v === '' ? null : Number(v) } }), 'Gespeichert – laufende Sessions ziehen um')),
            h('p', { class: 'muted small' }, 'Gilt für alle Server dieser Identität, die nicht unten etwas Eigenes haben.')),
          h('div', { class: 'section-title' }, 'Server & Zuweisungen'),
          detail.assignments.length
            ? detail.assignments.map((a) => {
                const sess = row.sessions.find((x) => x.serverId === a.serverId) || { state: 'STOPPED', desired: a.desiredState };
                const [cls, text] = stateOf(sess.state);
                const server = servers.find((x) => x.id === a.serverId);
                const p = a.placement;
                const pval = p === 'default' || !p ? 'default' : p === 'local' ? 'local' : String(p.agentId);
                const on = a.desiredState === 'ONLINE';
                return h('div', { class: 'card' },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                    h('div', { style: { flex: '1', minWidth: '0' } }, h('div', { class: 'name' }, h('b', null, server?.name ?? `Server ${a.serverId}`)), h('div', { class: 'muted small' }, server ? `${server.host}${server.port !== 25565 ? `:${server.port}` : ''}` : '')),
                    h('span', { class: `pill ${cls}` }, text)),
                  h('label', null, 'Läuft auf'),
                  select([['default', `Wie die Identität (${placeLabel(agents, identityAgent)})`], ['local', placeLabel(agents, null)], ...agentOpts], pval, (v) =>
                    change(() => pc('PUT', `/api/identities/${r.id}/servers/${a.serverId}/placement`, { placement: v === 'default' || v === 'local' ? v : Number(v) }), 'Gespeichert – die Session zieht um')),
                  h('div', { class: 'btns' },
                    on
                      ? h('button', { class: 'btn small danger', onclick: () => change(() => pc('POST', `/api/sessions/${r.id}:${a.serverId}/stop`), 'Gestoppt') }, 'Stoppen')
                      : h('button', { class: 'btn small primary', onclick: () => change(() => pc('POST', `/api/identities/${r.id}/sessions/${a.serverId}/start`), 'Startet') }, 'Starten'),
                    on ? h('button', { class: 'btn small', onclick: () => change(() => pc('POST', `/api/sessions/${r.id}:${a.serverId}/reconnect`), 'Verbindet neu') }, 'Neu verbinden') : null,
                    h('button', { class: 'btn small danger', onclick: () => confirm(`${server?.name ?? 'Server'} von ${name} entfernen? Die Session wird beendet.`) && change(() => pc('DELETE', `/api/identities/${r.id}/servers/${a.serverId}`), 'Zuweisung entfernt') }, 'Entfernen')));
              })
            : h('div', { class: 'card muted' }, 'Keinem Server zugewiesen.'),
          free.length
            ? h('div', { class: 'card' },
                h('label', null, 'Server hinzufügen'),
                (() => {
                  const sel = select(free.map((x) => [x.id, x.name]), free[0].id, () => undefined);
                  return h('div', { class: 'send' }, sel, h('button', { class: 'btn primary', onclick: () => change(() => pc('PUT', `/api/identities/${r.id}/servers/${sel.value}`, {}), 'Server zugewiesen') }, 'Hinzufügen'));
                })())
            : null);
      } catch (e) {
        fill(body, h('div', { class: 'banner err' }, e.message));
      }
    };
    return reload;
  }

  /** Servers: add one, see who is assigned, assign a server to several identities at once. */
  function serversSheet() {
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    sheet(h('h2', null, 'Server & Zuweisungen'), body);
    const reload = async () => {
      try {
        const [servers, rows] = await Promise.all([pc('GET', '/api/servers'), pc('GET', '/api/dashboard').then((d) => d.rows)]);
        const assignedTo = (sid) => rows.filter((r) => r.sessions.some((x) => x.serverId === sid));
        const name = h('input', { placeholder: 'Name, z. B. SMP' });
        const host = h('input', { placeholder: 'Adresse, z. B. play.example.de', autocapitalize: 'none', inputmode: 'url' });
        const port = h('input', { placeholder: '25565', inputmode: 'numeric' });
        fill(body, [
          servers.length
            ? servers.map((x) => {
                const who = assignedTo(x.id);
                const online = rows.reduce((n, r) => n + r.sessions.filter((y) => y.serverId === x.id && y.state === 'ONLINE').length, 0);
                return h('div', { class: 'row', onclick: () => serverSheet(x) },
                  h('div', { class: 'avatar' }, x.name.slice(0, 2).toUpperCase()),
                  h('div', { class: 'main' }, h('div', { class: 'name' }, x.name), h('div', { class: 'meta' }, `${x.host}${x.port !== 25565 ? `:${x.port}` : ''} · ${who.length} Identität(en)`)),
                  h('span', { class: `pill ${online ? 'ok' : ''}` }, `${online} online`));
              })
            : h('div', { class: 'card muted' }, 'Noch keine Server.'),
          h('div', { class: 'section-title' }, 'Neuer Server'),
          h('div', { class: 'card' }, name, h('div', { style: { height: '8px' } }), host, h('div', { style: { height: '8px' } }), port,
            h('button', { class: 'btn primary wide', style: { marginTop: '10px' }, onclick: () => act(async () => {
              if (!name.value.trim() || !host.value.trim()) throw new Error('Name und Adresse eingeben');
              const created = await pc('POST', '/api/servers', { name: name.value.trim(), host: host.value.trim(), port: Number(port.value) || 25565 });
              serverSheet(created);
            }, 'Server angelegt') }, 'Server anlegen'))]);
      } catch (e) {
        fill(body, h('div', { class: 'banner err' }, e.message));
      }
    };
    void reload();
  }

  /** One server: tick the identities that should play there; start / stop them all there. */
  function serverSheet(x) {
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    sheet(h('h2', null, x.name), h('div', { class: 'muted small' }, `${x.host}${x.port !== 25565 ? `:${x.port}` : ''}`), body);
    const reload = async () => {
      try {
        const rows = (await pc('GET', '/api/dashboard')).rows;
        const has = (r) => r.sessions.some((y) => y.serverId === x.id);
        const change = (fn, ok) => act(async () => { await fn(); await reload(); }, ok);
        const assigned = rows.filter(has);
        fill(body, 
          h('div', { class: 'section-title' }, `Identitäten auf diesem Server (${assigned.length}/${rows.length})`),
          rows.length
            ? rows.map((r) => {
                const sess = r.sessions.find((y) => y.serverId === x.id);
                const [cls, text] = sess ? stateOf(sess.state) : ['', 'nicht zugewiesen'];
                const box = h('input', { type: 'checkbox', checked: !!sess, style: { width: '22px', height: '22px', flex: 'none' } });
                box.addEventListener('change', () => change(
                  () => (box.checked ? pc('PUT', `/api/identities/${r.id}/servers/${x.id}`, {}) : pc('DELETE', `/api/identities/${r.id}/servers/${x.id}`)),
                  box.checked ? 'Zugewiesen' : 'Zuweisung entfernt'));
                return h('label', { class: 'row', style: { margin: '0 0 8px' } }, box,
                  h('div', { class: 'main' }, h('div', { class: 'name' }, r.label || r.minecraft.username || `#${r.number}`), h('div', { class: 'meta' }, r.minecraft.username || '')),
                  h('span', { class: `pill ${cls}` }, text));
              })
            : h('div', { class: 'card muted' }, 'Keine Identitäten.'),
          h('div', { class: 'btns' },
            h('button', { class: 'btn', onclick: () => change(async () => { for (const r of rows.filter((r) => !has(r))) await pc('PUT', `/api/identities/${r.id}/servers/${x.id}`, {}); }, 'Alle zugewiesen') }, 'Alle zuweisen'),
            assigned.length ? h('button', { class: 'btn primary', onclick: () => change(() => pc('POST', '/api/bulk', { action: 'startSessions', identityIds: assigned.map((r) => r.id), serverIds: [x.id] }), 'Starten auf diesem Server') }, 'Alle hier starten') : null,
            assigned.length ? h('button', { class: 'btn', onclick: () => change(() => pc('POST', '/api/bulk', { action: 'stopSessions', identityIds: assigned.map((r) => r.id), serverIds: [x.id] }), 'Gestoppt') }, 'Alle hier stoppen') : null),
          h('div', { class: 'btns' },
            h('button', { class: 'btn danger small', onclick: () => confirm(`Server „${x.name}“ löschen? Alle Zuweisungen zu ihm werden entfernt.`) && act(async () => { await pc('DELETE', `/api/servers/${x.id}`); serversSheet(); }, 'Server gelöscht') }, 'Server löschen')));
      } catch (e) {
        fill(body, h('div', { class: 'banner err' }, e.message));
      }
    };
    void reload();
  }

  /** Agent: online / paused, its sessions, pause / resume, which identities run there. */
  function agentSheet(a) {
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    sheet(h('h2', null, a.name), body);
    const reload = async () => {
      try {
        const [agents, rows] = await Promise.all([pc('GET', '/api/backend/agents'), pc('GET', '/api/dashboard').then((d) => d.rows)]);
        const ag = agents.find((x) => x.id === a.id) || a;
        const nameOfSid = (sid) => {
          const r = rows.find((x) => String(x.id) === String(sid).split(':')[0]);
          const sess = r?.sessions.find((x) => x.id === sid);
          return `${r ? r.minecraft.username || r.label : sid}${sess ? ` · ${sess.serverName}` : ''}`;
        };
        const change = (fn, ok) => act(async () => { await fn(); setTimeout(reload, 700); }, ok);
        fill(body, 
          h('div', null, h('span', { class: `pill ${ag.online ? (ag.paused ? 'warn' : 'ok') : ''}` }, ag.online ? (ag.paused ? 'pausiert' : 'online') : 'offline'), ' ',
            h('span', { class: 'muted small' }, ag.info?.os || '')),
          h('div', { class: 'kv' },
            h('div', null, 'Öffentliche IP'), h('div', { style: { fontFamily: 'ui-monospace, monospace' } }, ag.info?.publicIp || (ag.ip ? `${ag.ip} (Verbindung)` : 'unbekannt')),
            h('div', null, 'Sessions dort'), h('div', null, String(ag.sessions?.length ?? 0)),
            ag.lastSeenAt ? [h('div', null, 'Zuletzt gesehen'), h('div', null, new Date(ag.lastSeenAt).toLocaleString('de-DE'))] : null),
          ag.online
            ? h('div', { class: 'btns' }, ag.paused
                ? h('button', { class: 'btn primary', onclick: () => change(() => pc('POST', `/api/backend/agents/${ag.id}/pause`, { paused: false }), 'Agent fortgesetzt') }, 'Fortsetzen')
                : h('button', { class: 'btn danger', onclick: () => confirm(`„${ag.name}“ pausieren? Die Sessions dort werden beendet und starten erst nach dem Fortsetzen wieder.`) && change(() => pc('POST', `/api/backend/agents/${ag.id}/pause`, { paused: true }), 'Agent pausiert') }, 'Pausieren'))
            : h('p', { class: 'muted small' }, 'Offline – Sessions, die hier laufen sollen, warten, bis der Agent wieder online ist.'),
          ag.outdated ? h('div', { class: 'banner', style: { marginTop: '10px' } }, `Älterer Stand als die Suite (Build ${ag.suiteBuild}).${/android/i.test(ag.info?.os ?? '') ? ' Am Handy in der Agent-App auf „Herunterladen & installieren“ tippen.' : ''}`) : null,
          ag.online && !/android/i.test(ag.info?.os ?? '')
            ? h('button', { class: 'btn wide', style: { marginTop: '8px' }, onclick: () => confirm(`„${ag.name}“ jetzt aktualisieren? Die Sessions dort verbinden sich nach dem Neustart neu.`) && change(() => pc('POST', `/api/backend/agents/${ag.id}/update`), 'Update angefordert – der Agent startet gleich neu') }, 'Jetzt aktualisieren')
            : null,
          ag.info?.version ? h('p', { class: 'muted small' }, `Version: ${ag.info.version}`) : null,
          h('div', { class: 'section-title' }, 'Läuft gerade dort'),
          ag.sessions?.length ? h('div', { class: 'card feed' }, ag.sessions.map((sid) => h('div', null, h('span', { class: 'dot ok' }), h('span', null, nameOfSid(sid))))) : h('div', { class: 'card muted' }, 'Nichts.'),
          h('div', { class: 'section-title' }, 'Identitäten, die standardmäßig hier laufen'),
          (() => {
            const list = rows.filter((r) => r.agentId === ag.id);
            return list.length ? h('div', { class: 'card feed' }, list.map((r) => h('div', null, h('span', null, r.label || r.minecraft.username)))) : h('div', { class: 'card muted small' }, 'Zuweisen: unter Identitäten → Identität antippen → „Läuft auf“.');
          })());
      } catch (e) {
        fill(body, h('div', { class: 'banner err' }, e.message));
      }
    };
    void reload();
  }

  function viewMacros() {
    const m = cache.macros;
    if (!m) return h('div', { class: 'empty' }, 'Lädt…');
    const TRIGGER = { manual: 'per Hand', spawn: 'beim Betreten', chat: 'bei Chat', interval: 'regelmäßig', time: 'zur Uhrzeit', health: 'bei wenig Leben', food: 'bei Hunger', death: 'nach dem Tod', playerNearby: 'Spieler in der Nähe' };
    return h('div', null,
      m.macros.length
        ? m.macros.map((x) => h('div', { class: 'card' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { class: `dot ${x.enabled ? 'ok' : ''}` }),
              h('div', { style: { flex: '1' } }, h('div', { class: 'name' }, h('b', null, x.name)), h('div', { class: 'muted small' }, `${TRIGGER[x.trigger?.type] || x.trigger?.type} · ${x.blocks.length} Bausteine${x.enabled ? '' : ' · inaktiv'}`))),
            h('div', { class: 'btns' },
              h('button', { class: 'btn primary small', onclick: () => act(async () => { const r = await pc('POST', `/api/macros/${x.id}/run`, { sessionId: 'all' }); toast(`Gestartet auf ${r.sessions.length} Session(s)`, 'ok'); }) }, 'Ausführen'),
              h('button', { class: 'btn small', onclick: () => act(() => pc('POST', `/api/macros/${x.id}/stop`, { sessionId: 'all' }), 'Gestoppt') }, 'Stopp'))))
        : h('div', { class: 'card empty' }, 'Noch keine Makros – sie entstehen in der Suite am PC.'),
      m.log?.length ? [h('div', { class: 'section-title' }, 'Protokoll'), h('div', { class: 'card feed' }, m.log.slice(0, 12).map((l) => h('div', null, h('time', null, timeOf(l.ts)), h('span', null, `${m.macros.find((x) => x.id === l.macroId)?.name ?? `#${l.macroId}`}: ${l.status}${l.message ? ` – ${l.message}` : ''}`))))] : null);
  }

  /** Public IPs of the PCs and agents – sessions without proxy connect to the servers with them. */
  function ipSection() {
    const ips = cache.ips;
    if (!ips) return null;
    const copyIp = (ip) => (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(ip).then(() => toast('IP kopiert', 'ok'), () => toast(ip));
    };
    const row = (name, kind, ip, fallback, dot) => h('div', { class: 'row' },
      h('span', { class: `dot ${dot}` }),
      h('div', { class: 'main' }, h('div', { class: 'name' }, name), h('div', { class: 'meta' }, kind)),
      ip ? h('button', { class: 'pill ip', title: 'Kopieren', onclick: copyIp(ip) }, ip) : h('span', { class: 'pill' }, fallback || 'unbekannt'));
    return [
      h('div', { class: 'section-title' }, 'Öffentliche IPs',
        h('button', { class: 'link', onclick: () => act(async () => { cache.ips = await pc('POST', '/api/public-ips/refresh'); paint(); }, 'Geprüft') }, 'neu prüfen')),
      ...ips.pcs.map((p) => row(p.name, p.active ? 'PC · lässt die Sessions laufen' : 'PC · Standby', p.publicIp, p.seenIp, p.active ? 'ok' : 'info')),
      ...ips.agents.map((a) => row(a.name, `Agent · ${a.online ? (a.paused ? 'pausiert' : 'online') : 'offline'}`, a.online ? a.publicIp : null, a.online ? a.seenIp : a.publicIp ? `${a.publicIp} (zuletzt)` : 'offline', a.online ? (a.paused ? 'warn' : 'ok') : '')),
      h('p', { class: 'muted small', style: { margin: '6px 4px 0' } }, 'Mit dieser IP verbinden sich Sessions ohne Proxy zu den Servern. Sessions mit Proxy nutzen die IP des Proxys.'),
    ];
  }

  function viewMore() {
    const agents = cache.agents || [];
    const pref = themePref();
    const setTheme = (v) => {
      try {
        localStorage.setItem(THEME_KEY, v);
      } catch {
        /* private mode */
      }
      applyTheme();
      paint();
    };
    const go = (t) => { tab = t; shell(); refresh(); };
    return h('div', null,
      h('div', { class: 'title-xl' }, 'Mehr'),
      h('div', { class: 'group menu', style: { marginTop: '14px' } },
        h('div', { class: 'kvrow', onclick: () => go('macro') }, h('span', null, 'Makros'), h('b', null, '›')),
        h('div', { class: 'kvrow', onclick: () => alertsSheet() }, h('span', null, 'Stern-Warnungen'), h('b', null, '›')),
        h('div', { class: 'kvrow', onclick: () => starsSheet() }, h('span', null, 'Sterne-Statistik'), h('b', null, '›')),
        h('div', { class: 'kvrow', onclick: () => serversSheet() }, h('span', null, 'Server & Zuweisungen'), h('b', null, '›'))),
      h('div', { class: 'section-title' }, 'Erscheinungsbild'),
      h('div', { class: 'seg' }, [['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => h('button', { class: pref === v ? 'on' : '', onclick: () => setTheme(v) }, l))),
      h('div', { class: 'section-title' }, 'Agents', h('span', { class: 'muted small' }, 'antippen zum Steuern')),
      agents.length
        ? agents.map((a) => h('div', { class: 'row', onclick: () => agentSheet(a) },
            h('span', { class: `dot ${a.online ? (a.paused ? 'warn' : 'ok') : ''}` }),
            h('div', { class: 'main' }, h('div', { class: 'name' }, a.name), h('div', { class: 'meta' }, `${a.online ? (a.paused ? 'pausiert' : 'online') : 'offline'}${a.sessions?.length ? ` · ${a.sessions.length} Session(s)` : ''}${a.info?.os ? ` · ${a.info.os}` : ''}`)),
            a.outdated ? h('span', { class: 'pill warn' }, 'veraltet') : null))
        : h('div', { class: 'card empty' }, 'Keine Agents – installiere den Hoelni Agent auf einem PC oder Handy und melde ihn mit diesem Konto an.'),
      ipSection(),
      h('div', { class: 'section-title' }, 'PCs dieses Kontos'),
      (status?.pcs || []).length
        ? status.pcs.map((p) => h('div', { class: 'row' }, h('span', { class: `dot ${p.active ? 'ok' : 'info'}` }), h('div', { class: 'main' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, p.active ? 'aktiv – lässt die Sessions laufen' : 'Standby')), h('span', { class: `pill ${p.active ? 'ok' : ''}` }, p.active ? 'aktiv' : 'Standby')))
        : h('div', { class: 'card empty' }, 'Kein PC verbunden.'),
      h('div', { class: 'section-title' }, 'Konto'),
      h('div', { class: 'card' },
        h('div', { class: 'kv' }, h('div', null, 'Angemeldet als'), h('div', null, status?.user?.username || session.user), h('div', null, 'Gerät'), h('div', null, status?.device?.name || '–'), h('div', null, 'Backend'), h('div', null, location.host)),
        h('p', { class: 'muted small' }, 'Die Sessions laufen auf dem aktiven PC. Diese App steuert ihn nur – Tresor, Anmeldungen und Fenster bleiben am PC.'),
        bridge ? h('p', { class: 'muted small' }, 'Tipp: Lege die Widgets „Hoelni Status“ und „Hoelni Schnellaktionen“ auf den Startbildschirm (lange auf den Startbildschirm tippen → Widgets).') : null,
        h('button', { class: 'btn danger wide', onclick: () => confirm('Dieses Gerät abmelden?') && signOut() }, 'Abmelden'),
        bridge ? h('button', { class: 'btn wide', style: { marginTop: '8px' }, onclick: () => bridge.changeBackend() }, 'Backend-Adresse ändern') : null));
  }

  // ------------------------------------------------------------------ sign-in
  function viewLogin(error) {
    stopLive();
    topEl = null;
    mainEl = null;
    const user = h('input', { autocomplete: 'username', autocapitalize: 'none', value: session?.user || '' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    let name = 'Hoelni Control';
    try {
      name = bridge?.deviceName() || (/(iPhone|iPad|Android)/.exec(navigator.userAgent)?.[1] ?? 'Browser');
    } catch {
      /* older app */
    }
    const go = async () => {
      try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.value.trim(), password: pw.value, client: 'remote', name: `Control: ${name}` }) });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error || `Fehler ${r.status}`);
        save({ token: b.token, user: b.user.username });
        start();
      } catch (e) {
        viewLogin(e.message);
      }
    };
    pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    app.replaceChildren(h('div', { class: 'login' },
      h('img', { src: 'icon-192.png', alt: 'Hoelni' }),
      h('h1', null, 'Hoelni Control'),
      h('p', { class: 'lead' }, 'Steuere deine Hoelni Client Suite von unterwegs.'),
      error ? h('div', { class: 'banner err' }, error) : null,
      h('label', null, 'Benutzername'), user,
      h('label', null, 'Passwort'), pw,
      h('button', { class: 'btn primary wide', style: { marginTop: '18px' }, onclick: go }, 'Anmelden'),
      h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '18px' } }, `Backend: ${location.host}`)));
  }

  async function signOut(silent) {
    if (!silent && session) await fetch('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } }).catch(() => undefined);
    save(null);
    cache = {};
    viewLogin(silent ? 'Bitte neu anmelden.' : null);
  }

  function start() {
    shell();
    refresh();
    startLive();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session && mainEl) {
      refresh(true);
      if (!liveAbort) startLive();
    }
  });
  setInterval(() => session && mainEl && !document.hidden && refresh(true), 30_000);
  // the Android app opens a tab directly (widget buttons)
  const want = new URLSearchParams(location.search).get('tab');
  if (want && ['home', 'sessions', 'chat', 'people', 'macro', 'more'].includes(want)) tab = want;
  // a tapped star notification opens the warnings
  if (want === 'alerts') {
    tab = 'home';
    setTimeout(() => void alertsSheet().catch(() => undefined), 800);
  }
  if (session?.token) start();
  else viewLogin();
})();
