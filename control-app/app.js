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
  function shell() {
    topEl = h('header', { class: 'top' });
    mainEl = h('main');
    const nav = h('nav', { class: 'nav' },
      [['home', 'Übersicht'], ['sessions', 'Sessions'], ['chat', 'Chat'], ['people', 'Identitäten'], ['macro', 'Makros'], ['more', 'Agents']].map(([id, label]) =>
        h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; shell(); refresh(); } }, icon(id === 'people' ? 'people' : id), label)));
    app.replaceChildren(topEl, mainEl, nav);
    paintTop();
  }
  let busy = false;
  function paintTop() {
    if (!topEl) return;
    const active = status?.active;
    topEl.replaceChildren(
      h('img', { src: 'icon-192.png', alt: '' }),
      h('div', { class: 'title' },
        h('h1', null, 'Hoelni Control'),
        h('div', { class: 'sub' }, h('span', { class: `dot ${active ? (live ? 'ok' : 'info') : 'err'}`, style: { display: 'inline-block', marginRight: '6px', width: '8px', height: '8px' } }),
          active ? `${active.name}${live ? ' · live' : ''}` : 'kein PC aktiv')),
      h('button', { class: `icon-btn ${busy ? 'spin' : ''}`, title: 'Aktualisieren', onclick: () => refresh() }, icon('refresh')));
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
      if (tab === 'home') [cache.summary, cache.stars] = await Promise.all([pc('GET', '/api/summary'), pc('GET', '/api/stars').catch(() => null)]);
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
  function viewHome() {
    const s = cache.summary;
    if (!s) return h('div', { class: 'empty' }, 'Lädt…');
    const pct = s.sessions.wanted ? Math.round((s.sessions.online / s.sessions.wanted) * 100) : 0;
    const bar = h('i');
    bar.style.width = `${Math.min(100, pct)}%`;
    return h('div', null,
      h('div', { class: 'hero' },
        h('div', { class: 'big' }, String(s.sessions.online), h('small', null, ` / ${s.sessions.wanted}`)),
        h('div', { class: 'label' }, `Sessions online${s.sessions.problems ? ` · ${s.sessions.problems} mit Problemen` : ''} · auf „${status.active.name}“`),
        h('div', { class: 'bar' }, bar)),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, `${s.identities.ready}/${s.identities.total}`), h('span', null, 'Identitäten bereit')),
        h('div', { class: 'stat' }, h('b', null, `${s.agents.online}`), h('span', null, `Agents online`)),
        h('button', { class: 'stat tap', onclick: () => starsSheet() }, h('b', null, fmtNum(cache.stars?.total ?? s.stars)), h('span', null, 'Sterne gesamt'),
          cache.stars?.gained.h24 ? h('em', null, `+${fmtNum(cache.stars.gained.h24)} in 24 h`) : null)),
      s.starAlerts && s.starAlerts.length ? alertsCard(s.starAlerts) : null,
      cache.stars ? starsCard(cache.stars) : null,
      h('div', { class: 'section-title' }, 'Schnellaktionen'),
      h('div', { class: 'actions' },
        h('button', { class: 'action', onclick: () => bulk('startSessions', 'Die Accounts gehen nacheinander online – in den nächsten Minuten') }, icon('play'), 'Alle online'),
        h('button', { class: 'action', onclick: () => confirm('Alle Sessions offline setzen?') && bulk('stopSessions', 'Alle Sessions gestoppt') }, icon('stop'), 'Alle offline'),
        h('button', { class: 'action', onclick: () => bulk('reconnect', 'Neu verbinden…') }, icon('reconnect'), 'Neu verbinden')),
      h('div', { class: 'section-title' }, 'Sessions'),
      s.sessions.list.length ? s.sessions.list.map((x) => sessionRow((cache.sessions || []).find((y) => y.id === x.id) || { id: x.id, state: x.state, serverName: x.server, username: x.name })) : h('div', { class: 'card empty' }, 'Keine Session soll online sein.'),
      h('div', { class: 'section-title' }, 'Live'),
      h('div', { class: 'card feed' }, feed.length ? feed.slice(0, 10).map((f) => h('div', null, h('time', null, timeOf(f.at)), h('span', null, f.text))) : h('span', { class: 'muted' }, live ? 'Wartet auf Ereignisse…' : 'Live-Verbindung wird aufgebaut…')));
  }

  // ------------------------------------------------------------------ stars
  const fmtNum = (n) => Number(n || 0).toLocaleString('de-DE');
  let starsRange = 'day';

  /** Bars of stars gained (one series, one hue); tap a bar for its value. */
  function starsChart(points, label, caption) {
    const W = 300;
    const HGT = 96;
    const max = Math.max(1, ...points.map((p) => p.gained));
    const step = W / points.length;
    const bw = Math.max(2, step - 2); // 2px gap between bars
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${HGT + 1}`);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${caption.textContent}`);
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    // recessive guide at the maximum
    svg.append(el('line', { x1: 0, x2: W, y1: 8, y2: 8, class: 'grid' }));
    const def = caption.textContent;
    points.forEach((p, i) => {
      const x = i * step + (step - bw) / 2;
      const hgt = p.gained ? Math.max(3, (p.gained / max) * (HGT - 10)) : 0;
      const r = Math.min(4, bw / 2, hgt);
      if (hgt) {
        // rounded top (4px), square on the baseline
        const y = HGT - hgt;
        svg.append(el('path', { class: 'bar', d: `M${x},${HGT} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${HGT} Z` }));
      }
      const hit = el('rect', { x: i * step, y: 0, width: step, height: HGT, class: 'hit' });
      const show = () => {
        caption.textContent = `${label(p)}: +${fmtNum(p.gained)} ★`;
        svg.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
        hit.classList.add('on');
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('click', show);
      svg.append(hit);
    });
    svg.addEventListener('pointerleave', () => {
      caption.textContent = def;
      svg.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
    });
    svg.append(el('line', { x1: 0, x2: W, y1: HGT + 0.5, y2: HGT + 0.5, class: 'axis' }));
    return svg;
  }

  function starsCard(st) {
    const daily = starsRange === 'day';
    const pts = daily ? st.hourly : st.daily;
    const sum = pts.reduce((a, p) => a + p.gained, 0);
    const caption = h('div', { class: 'chart-cap' }, daily ? `+${fmtNum(sum)} ★ in den letzten 24 Stunden` : `+${fmtNum(sum)} ★ in den letzten 30 Tagen`);
    const label = daily
      ? (p) => `${pad2(new Date(p.t).getHours())}–${pad2((new Date(p.t).getHours() + 1) % 24)} Uhr`
      : (p) => new Date(`${p.day}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
    const kpi = (v, t) => h('div', null, h('b', null, `+${fmtNum(v)}`), h('span', null, t));
    return h('div', { class: 'card stars' },
      h('div', { class: 'stars-head' },
        h('div', null, h('div', { class: 'name' }, h('b', null, 'Sterne')), h('div', { class: 'muted small' }, `${fmtNum(st.online)} ★ auf den Accounts, die gerade online sind`)),
        h('div', { class: 'seg' },
          h('button', { class: daily ? 'on' : '', onclick: () => { starsRange = 'day'; paint(); } }, '24 h'),
          h('button', { class: daily ? '' : 'on', onclick: () => { starsRange = 'month'; paint(); } }, '30 Tage'))),
      h('div', { class: 'kpis' }, kpi(st.gained.h24, '24 Stunden'), kpi(st.gained.d7, '7 Tage'), kpi(st.gained.d30, '30 Tage'), kpi(st.gained.d365, '1 Jahr')),
      caption,
      starsChart(pts, label, caption),
      h('div', { class: 'chart-x' }, h('span', null, daily ? 'vor 24 h' : 'vor 30 Tagen'), h('span', null, daily ? 'jetzt' : 'heute')),
      h('button', { class: 'btn wide', style: { marginTop: '10px' }, onclick: () => starsSheet() }, 'Sterne pro Identität'));
  }

  // ------------------------------------------------------------------ star alerts
  const ALERT_KIND = { stall: 'Keine Sterne', spike: 'Ungewöhnlich viele Sterne', drop: 'Sterne verloren', test: 'Test' };
  const alertTitle = (a) => (a.kind === 'test' ? 'Test' : `${a.name}${a.server ? ` (${a.server})` : ''} – ${ALERT_KIND[a.kind] || a.kind}`);
  const alertRow = (a) => h('div', { class: 'alert-row' }, h('time', null, timeOf(a.ts)), h('div', null, h('b', null, alertTitle(a)), h('div', { class: 'muted small' }, a.textDe)));

  /** Warnings of the last 24 hours on the home tab. */
  function alertsCard(list) {
    return h('div', { class: 'card alerts' },
      h('div', { class: 'name' }, h('b', null, 'Stern-Warnungen'), h('span', { class: 'muted small' }, ' · letzte 24 h')),
      list.slice(0, 3).map(alertRow),
      h('button', { class: 'btn wide', style: { marginTop: '8px' }, onclick: () => alertsSheet() }, 'Alle Warnungen und Einstellungen'));
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
      h('div', { class: 'avatar' }, name.slice(0, 2).toUpperCase()),
      h('div', { class: 'main' }, h('div', { class: 'name' }, name), h('div', { class: 'meta' }, s.serverName || '', s.agentId ? ' · Agent' : '', s.stats?.ping != null ? ` · ${s.stats.ping} ms` : '')),
      h('span', { class: `pill ${cls}` }, text));
  }

  // ------------------------------------------------------------------ sheets
  let openChat = null;
  function sheet(...content) {
    const root = document.getElementById('sheet-root');
    const close = () => {
      root.replaceChildren();
      openChat = null;
    };
    const bg = h('div', { class: 'sheet-bg', onclick: (e) => e.target === bg && close() }, h('div', { class: 'sheet' }, h('div', { class: 'grip' }), ...content));
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

  function viewPeople() {
    const rows = cache.rows || [];
    const head = h('div', { class: 'actions', style: { gridTemplateColumns: '1fr 1fr', marginBottom: '12px' } },
      h('button', { class: 'action', onclick: () => serversSheet() }, icon('sessions'), 'Server & Zuweisungen'),
      h('button', { class: 'action', onclick: () => { tab = 'more'; shell(); refresh(); } }, icon('people'), 'Agents'));
    if (!rows.length) return h('div', null, head, h('div', { class: 'card empty' }, 'Keine Identitäten.'));
    return h('div', null, head, rows.map((r) => {
      const online = r.sessions.filter((x) => x.state === 'ONLINE').length;
      const cls = r.sessions.some((x) => x.state === 'BLOCKED') ? 'err' : online ? 'ok' : r.sessions.some((x) => x.desired === 'ONLINE') ? 'warn' : '';
      const name = r.label || `Identity${pad2(r.number)}`;
      return h('div', { class: 'row', onclick: () => personSheet(r) },
        h('div', { class: 'avatar' }, pad2(r.number)),
        h('div', { class: 'main' }, h('div', { class: 'name' }, name), h('div', { class: 'meta' }, r.minecraft.username || 'kein Minecraft', ` · ${r.stars} ★`)),
        h('span', { class: `dot ${cls}` }),
        h('span', { class: 'pill' }, `${online}/${r.sessions.length}`));
    }));
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
  function personSheet(r) {
    const name = r.label || `Identity${pad2(r.number)}`;
    const body = h('div', null, h('div', { class: 'muted small' }, 'Lädt…'));
    const close = sheet(h('h2', null, name), h('div', { class: 'muted small' }, `${r.minecraft.username || 'kein Minecraft'} · ${r.stars} ★ · ${r.ready ? 'bereit' : ({ OK: 'in Ordnung', WARNING: 'Hinweise', ERROR: 'Probleme', BLOCKED: 'blockiert' })[r.health] || r.health}`), body);
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
            : null,
          h('div', { class: 'btns' },
            h('button', { class: 'btn', onclick: () => change(() => pc('POST', '/api/bulk', { action: 'startSessions', identityIds: [r.id] }), 'Alle Server dieser Identität starten') }, 'Alle starten'),
            h('button', { class: 'btn', onclick: () => change(() => pc('POST', '/api/bulk', { action: 'stopSessions', identityIds: [r.id] }), 'Gestoppt') }, 'Alle stoppen')));
      } catch (e) {
        fill(body, h('div', { class: 'banner err' }, e.message));
      }
    };
    void reload();
    return close;
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
    return h('div', null,
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
      h('img', { src: 'logo.png', alt: 'Hoelni' }),
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
