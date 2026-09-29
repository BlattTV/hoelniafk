import { api } from '../api.js';
import { clear, contextMenu, fmtBytes, guard, h, identityName, mount, openGame, closeGame, gameBadge, scheduleNote, pad2, relTime, select, stateBadge } from '../ui.js';
import { openChat, openSessionLog } from './sections.js';

/** Session Manager: every session with actual vs. desired state, filters and actions. */
export async function sessionsView(root) {
  const ctx = { chatListener: null };
  const head = h('div', { class: 'page-head' });
  const filters = h('div', { class: 'filters' });
  const wrap = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } });
  root.append(head, filters, wrap);
  const f = { q: '', state: '', server: '' };
  let sessions = [];
  let names = new Map();
  let servers = [];

  const act = (fn) => guard(fn).then(load);
  const menu = (e, s) =>
    contextMenu(e, [
      s.desiredState === 'ONLINE' ? ['Stop (set offline)', () => act(() => api.post(`/api/sessions/${s.id}/stop`))] : ['Start (set online)', () => act(() => api.post(`/api/identities/${s.identityId}/sessions/${s.serverId}/start`))],
      ['Reconnect', () => act(() => api.post(`/api/sessions/${s.id}/reconnect`))],
      ['Open game', () => openGame(api, s.id).then(load)],
      s.runtime === 'game' || (s.game && !['closed', 'failed'].includes(s.game.status)) ? ['Back to AFK', () => closeGame(api, s.id).then(load)] : undefined,
      null,
      ['Chat', () => openChat({ id: s.id, serverName: s.serverName }, ctx)],
      ['Session log', () => openSessionLog(s.id, `${names.get(s.identityId)} @ ${s.serverName}`)],
      ['Open identity', () => (location.hash = `#/identity/${s.identityId}/sessions`)],
    ].filter((x) => x !== undefined));

  const render = () => {
    const list = sessions.filter((s) =>
      (!f.state || s.state === f.state) && (!f.server || String(s.serverId) === f.server) &&
      (!f.q || `${names.get(s.identityId)} ${s.username ?? ''} ${s.serverName}`.toLowerCase().includes(f.q)));
    const by = (st) => sessions.filter((s) => s.state === st).length;
    mount(head, h('div', null, h('h1', null, 'Sessions'),
      h('div', { class: 'sub' }, `${by('ONLINE')} online · ${by('RECONNECTING')} reconnecting · ${by('BLOCKED')} blocked · ${sessions.filter((s) => s.desiredState === 'ONLINE').length} desired online · ${sessions.length} total`)));
    clear(wrap).appendChild(list.length
      ? h('table', null,
          h('thead', null, h('tr', null, ['Identity', 'Server', 'Should be', 'State', 'Since', 'Reconnects', 'Ping', 'Traffic', 'Mode', 'Last error / next attempt', ''].map((t) => h('th', null, t)))),
          h('tbody', null, list.map((s) => h('tr', { oncontextmenu: (e) => menu(e, s) },
            h('td', null, h('a', { href: `#/identity/${s.identityId}/sessions` }, names.get(s.identityId) ?? `#${s.identityId}`), s.username ? h('div', { class: 'muted' }, s.username) : null),
            h('td', null, s.serverName),
            h('td', null, s.desiredState === 'ONLINE' ? h('span', { class: 's-ok' }, 'online') : h('span', { class: 'muted' }, 'offline')),
            h('td', null, stateBadge(s.state, s.lastError ?? ''), scheduleNote(s)),
            h('td', { class: 'muted nowrap' }, relTime(s.since)),
            h('td', { class: 'mono' }, `${s.reconnects}${s.consecutiveFailures ? ` (${s.consecutiveFailures} failed)` : ''}`),
            h('td', { class: 'mono', dataset: { ping: s.id } }, s.stats?.ping !== null && s.stats?.ping !== undefined ? `${s.stats.ping} ms` : '–'),
            h('td', { class: 'mono muted', dataset: { traffic: s.id } }, s.stats ? `${fmtBytes(s.stats.bytesIn)} / ${fmtBytes(s.stats.bytesOut)}` : '–'),
            h('td', null, gameBadge(s) ?? (s.stats ? (s.stats.physics ? 'physics' : h('span', { class: 'muted', title: 'Physics off – lightweight AFK mode' }, 'lightweight')) : '–')),
            h('td', { class: s.state === 'BLOCKED' ? 's-error' : 'muted', style: { maxWidth: '320px', fontSize: '12px' } }, s.state === 'RECONNECTING' ? `next ${relTime(s.nextAttemptAt)} – ${s.lastError ?? ''}` : s.lastError ?? ''),
            h('td', null, h('div', { class: 'toolbar' },
              h('button', { class: 'small', title: 'Play in the real Minecraft client', onclick: () => openGame(api, s.id).then(load) }, 'Game'),
              h('button', { class: 'small', onclick: () => openChat({ id: s.id, serverName: s.serverName }, ctx) }, 'Chat'),
              h('button', { class: 'small', title: 'More actions', onclick: (e) => menu(e, s) }, 'More')))))))
      : h('div', { class: 'empty' }, sessions.length ? 'No session matches the filters.' : 'No sessions yet – set identities online in the Account × Server matrix.'));
  };

  const load = async () => {
    const [list, dash, srv] = await Promise.all([api.get('/api/sessions'), api.get('/api/dashboard'), api.get('/api/servers')]);
    sessions = list;
    names = new Map(dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`]));
    servers = srv;
    mount(filters,
      h('input', { type: 'search', placeholder: 'Search identity / player / server', value: f.q, oninput: (e) => { f.q = e.target.value.toLowerCase(); render(); } }),
      select('state', [['', 'any state'], 'ONLINE', 'CONNECTING', 'RECONNECTING', 'BLOCKED', 'STOPPED'], f.state, { onchange: (e) => { f.state = e.target.value; render(); } }),
      select('server', [['', 'all servers'], ...servers.map((s) => [s.id, s.name])], f.server, { onchange: (e) => { f.server = e.target.value; render(); } }));
    render();
  };
  await load();
  let t;
  return {
    onEvent(ev) {
      if (ctx.chatListener) ctx.chatListener(ev);
      if (ev.type === 'session.stats' && ev.data?.sessionId) {
        // numbers only: update in place (a full reload every 5 s made the window flicker)
        const st = ev.data.stats;
        for (const el of root.querySelectorAll('[data-ping]')) if (el.dataset.ping === ev.data.sessionId) el.textContent = st.ping !== null && st.ping !== undefined ? `${st.ping} ms` : '–';
        for (const el of root.querySelectorAll('[data-traffic]')) if (el.dataset.traffic === ev.data.sessionId) el.textContent = `${fmtBytes(st.bytesIn)} / ${fmtBytes(st.bytesOut)}`;
        return;
      }
      if (ev.type === 'session.state' && !document.getElementById('modal-root').childElementCount) {
        clearTimeout(t);
        t = setTimeout(load, 700);
      }
    },
  };
}
