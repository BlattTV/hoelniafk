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
  const ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    sessions: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M17 14.5c2.4.2 4 1.8 4.5 4.5"/>',
    macro: '<path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="M11 7.5h4.5a2 2 0 0 1 2 2V13M13 16.5H8.5a2 2 0 0 1-2-2V11"/>',
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
    feed.splice(30);
    if (ev.type === 'session.chat' && openChat && ev.sessionId === openChat.id) openChat.add(ev.data);
    if (['session.state', 'identity.changed', 'macro', 'reward.changed', 'pcs.changed'].includes(ev.type)) {
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
      [['home', 'Übersicht'], ['sessions', 'Sessions'], ['people', 'Identitäten'], ['macro', 'Makros'], ['more', 'Mehr']].map(([id, label]) =>
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
      if (tab === 'home') cache.summary = await pc('GET', '/api/summary');
      if (tab === 'sessions' || tab === 'home') cache.sessions = await pc('GET', '/api/sessions');
      if (tab === 'people' || tab === 'sessions' || !cache.rows) cache.rows = (await pc('GET', '/api/dashboard')).rows;
      if (tab === 'macro') cache.macros = await pc('GET', '/api/macros');
      if (tab === 'more') cache.agents = await pc('GET', '/api/backend/agents').catch(() => []);
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
    const views = { home: viewHome, sessions: viewSessions, people: viewPeople, macro: viewMacros, more: viewMore };
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
        h('div', { class: 'stat' }, h('b', null, String(s.stars)), h('span', null, 'Sterne gesamt'))),
      h('div', { class: 'section-title' }, 'Schnellaktionen'),
      h('div', { class: 'actions' },
        h('button', { class: 'action', onclick: () => bulk('startSessions', 'Alle Sessions werden gestartet') }, icon('play'), 'Alle online'),
        h('button', { class: 'action', onclick: () => confirm('Alle Sessions offline setzen?') && bulk('stopSessions', 'Alle Sessions gestoppt') }, icon('stop'), 'Alle offline'),
        h('button', { class: 'action', onclick: () => bulk('reconnect', 'Neu verbinden…') }, icon('reconnect'), 'Neu verbinden')),
      h('div', { class: 'section-title' }, 'Sessions'),
      s.sessions.list.length ? s.sessions.list.map((x) => sessionRow((cache.sessions || []).find((y) => y.id === x.id) || { id: x.id, state: x.state, serverName: x.server, username: x.name })) : h('div', { class: 'card empty' }, 'Keine Session soll online sein.'),
      h('div', { class: 'section-title' }, 'Live'),
      h('div', { class: 'card feed' }, feed.length ? feed.slice(0, 10).map((f) => h('div', null, h('time', null, timeOf(f.at)), h('span', null, f.text))) : h('span', { class: 'muted' }, live ? 'Wartet auf Ereignisse…' : 'Live-Verbindung wird aufgebaut…')));
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
        h('button', { class: 'btn', onclick: () => chatSheet(s) }, 'Chat')));
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

  function viewPeople() {
    const rows = cache.rows || [];
    if (!rows.length) return h('div', { class: 'card empty' }, 'Keine Identitäten.');
    return h('div', null, rows.map((r) => {
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

  function personSheet(r) {
    let close;
    const name = r.label || `Identity${pad2(r.number)}`;
    close = sheet(
      h('h2', null, name),
      h('div', { class: 'muted small' }, `${r.minecraft.username || 'kein Minecraft'} · ${r.stars} ★ · ${r.ready ? 'bereit' : r.health}`),
      h('div', { class: 'section-title' }, 'Server'),
      r.sessions.length
        ? r.sessions.map((x) => {
            const [cls, text] = stateOf(x.state);
            const on = x.desired === 'ONLINE';
            return h('div', { class: 'row' },
              h('div', { class: 'main' }, h('div', { class: 'name' }, x.serverName), h('div', { class: 'meta' }, text)),
              h('span', { class: `pill ${cls}` }, text),
              on
                ? h('button', { class: 'btn small danger', onclick: () => act(async () => { await pc('POST', `/api/sessions/${x.id}/stop`); close(); }, 'Gestoppt') }, 'Stopp')
                : h('button', { class: 'btn small primary', onclick: () => act(async () => { await pc('POST', `/api/identities/${r.id}/sessions/${x.id.split(':')[1]}/start`); close(); }, 'Startet') }, 'Start'));
          })
        : h('div', { class: 'muted' }, 'Keinem Server zugewiesen.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => act(() => pc('POST', '/api/bulk', { action: 'startSessions', identityIds: [r.id] }), 'Alle Server dieser Identität starten') }, 'Alle starten'),
        h('button', { class: 'btn', onclick: () => act(() => pc('POST', '/api/bulk', { action: 'stopSessions', identityIds: [r.id] }), 'Gestoppt') }, 'Alle stoppen')));
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

  function viewMore() {
    const agents = cache.agents || [];
    return h('div', null,
      h('div', { class: 'section-title' }, 'PCs dieses Kontos'),
      (status?.pcs || []).length
        ? status.pcs.map((p) => h('div', { class: 'row' }, h('span', { class: `dot ${p.active ? 'ok' : 'info'}` }), h('div', { class: 'main' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, p.active ? 'aktiv – lässt die Sessions laufen' : 'Standby')), h('span', { class: `pill ${p.active ? 'ok' : ''}` }, p.active ? 'aktiv' : 'Standby')))
        : h('div', { class: 'card empty' }, 'Kein PC verbunden.'),
      h('div', { class: 'section-title' }, 'Agents'),
      agents.length
        ? agents.map((a) => h('div', { class: 'row' },
            h('span', { class: `dot ${a.online ? (a.paused ? 'warn' : 'ok') : ''}` }),
            h('div', { class: 'main' }, h('div', { class: 'name' }, a.name), h('div', { class: 'meta' }, `${a.online ? (a.paused ? 'pausiert' : 'online') : 'offline'}${a.sessions?.length ? ` · ${a.sessions.length} Session(s)` : ''}${a.info?.os ? ` · ${a.info.os}` : ''}`))))
        : h('div', { class: 'card empty' }, 'Keine Agents.'),
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
  if (want && ['home', 'sessions', 'people', 'macro', 'more'].includes(want)) tab = want;
  if (session?.token) start();
  else viewLogin();
})();
