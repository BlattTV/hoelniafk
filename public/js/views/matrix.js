import { api } from '../api.js';
import { clear, contextMenu, guard, h, mount, openGame, closeGame, pad2, relTime, stateBadge, toast } from '../ui.js';
import { openChat, openSessionLog } from './sections.js';

/**
 * Account × Server matrix: every cell is one potential session.
 * Click toggles the desired state; right-click opens the session actions.
 */
export async function matrixView(root) {
  const head = h('div', { class: 'page-head' });
  const filters = h('div', { class: 'filters' });
  const wrap = h('div', { class: 'card matrix', style: { padding: 0, overflow: 'auto' } });
  root.append(head, filters, wrap);
  const selectedRows = new Set();
  let q = '';
  let data = { servers: [], rows: [] };
  const ctx = { chatListener: null };

  const setDesired = (identityId, serverId, desired) =>
    guard(() => api.put(`/api/identities/${identityId}/servers/${serverId}/desired`, { state: desired })).then(load);

  const bulkColumn = async (serverId, desired) => {
    const ids = selectedRows.size ? [...selectedRows] : data.rows.map((r) => r.id);
    const res = await guard(() => api.post('/api/bulk', { action: desired === 'ONLINE' ? 'startSessions' : 'stopSessions', identityIds: ids, serverIds: [serverId] }));
    if (res) toast(`${res.results.filter((r) => r.ok).length}/${ids.length} identities updated`, 'ok');
    load();
  };

  const cellMenu = (e, row, srv, cell) => {
    const sid = `${row.id}:${srv.id}`;
    contextMenu(e, [
      cell.desiredState === 'ONLINE' ? ['Set offline (stop)', () => setDesired(row.id, srv.id, 'OFFLINE')] : ['Set online (start)', () => setDesired(row.id, srv.id, 'ONLINE')],
      ['Reconnect now', () => guard(() => api.post(`/api/sessions/${sid}/reconnect`)).then(load)],
      ['Open game', () => openGame(api, sid).then(load)],
      cell.runtime === 'game' || (cell.gameStatus && !['closed', 'failed'].includes(cell.gameStatus)) ? ['Back to AFK', () => closeGame(api, sid).then(load)] : undefined,
      null,
      ['Chat', () => openChat({ id: sid, serverName: srv.name }, ctx)],
      ['Session log', () => openSessionLog(sid, `${row.label} @ ${srv.name}`)],
      ['Open identity', () => (location.hash = `#/identity/${row.id}/sessions`)],
    ].filter((x) => x !== undefined));
  };

  const render = () => {
    const rows = data.rows.filter((r) => !q || `${r.label} ${r.username ?? ''} ${pad2(r.number)}`.toLowerCase().includes(q));
    let online = 0;
    let desired = 0;
    for (const r of data.rows) for (const c of r.cells) if (c.assigned) {
      if (c.state === 'ONLINE') online++;
      if (c.desiredState === 'ONLINE') desired++;
    }
    mount(head, h('div', null, h('h1', null, 'Accounts × servers'), h('div', { class: 'sub' }, `${online}/${desired} desired sessions online · click a cell to toggle SHOULD_BE_ONLINE / OFFLINE · right-click for actions`)));
    const table = h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, h('input', { type: 'checkbox', title: 'Select all', checked: rows.length && rows.every((r) => selectedRows.has(r.id)), onchange: (e) => { rows.forEach((r) => (e.target.checked ? selectedRows.add(r.id) : selectedRows.delete(r.id))); render(); } })),
        h('th', null, 'Identity'),
        data.servers.map((s) =>
          h('th', { style: { textAlign: 'center' } }, s.name,
            h('div', { class: 'toolbar', style: { justifyContent: 'center', marginTop: '4px' } },
              h('button', { class: 'small', title: `Set ${selectedRows.size ? 'selected' : 'all'} identities ONLINE on ${s.name}`, onclick: () => bulkColumn(s.id, 'ONLINE') }, 'all on'),
              h('button', { class: 'small', title: `Set ${selectedRows.size ? 'selected' : 'all'} identities OFFLINE on ${s.name}`, onclick: () => bulkColumn(s.id, 'OFFLINE') }, 'all off')))))),
      h('tbody', null, rows.map((r) =>
        h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: selectedRows.has(r.id), onchange: (e) => { e.target.checked ? selectedRows.add(r.id) : selectedRows.delete(r.id); render(); } })),
          h('td', null, h('a', { href: `#/identity/${r.id}` }, `#${pad2(r.number)} ${r.label}`), h('div', { class: 'muted' }, r.username ?? 'no Minecraft account')),
          r.cells.map((c, i) => {
            const srv = data.servers[i];
            if (!c.assigned) return h('td', { class: 'cell unassigned', title: 'Not assigned – assign the server in the identity' }, '·');
            const tip = [c.lastError, c.nextAttemptAt ? `next attempt ${relTime(c.nextAttemptAt)}` : null].filter(Boolean).join('\n');
            return h('td', {
              class: 'cell',
              onclick: () => setDesired(r.id, srv.id, c.desiredState === 'ONLINE' ? 'OFFLINE' : 'ONLINE'),
              oncontextmenu: (e) => cellMenu(e, r, srv, c),
            },
              stateBadge(c.state, tip),
              c.runtime === 'game' || (c.gameStatus && !['closed', 'failed'].includes(c.gameStatus)) ? h('span', { class: 'game-tag live', title: `Real game client: ${c.gameStatus ?? 'running'}` }, 'game') : null,
              h('span', { class: 'desired' }, c.desiredState === 'ONLINE' ? 'should be online' : 'should be offline', c.stars ? ` · ${c.stars} stars` : ''));
          })))),
    );
    clear(wrap).appendChild(data.servers.length ? table : h('div', { class: 'empty' }, 'No servers yet – add them under “Server Profiles”.'));
  };

  mount(filters, h('input', { type: 'search', placeholder: 'Filter identities…', oninput: (e) => { q = e.target.value.toLowerCase(); render(); } }));
  const load = async () => {
    data = await api.get('/api/matrix');
    render();
  };
  await load();
  let t;
  return {
    onEvent(ev) {
      if (ctx.chatListener) ctx.chatListener(ev);
      if (ev.type === 'session.state' || ev.type === 'identity.changed') {
        clearTimeout(t);
        t = setTimeout(load, 500);
      }
    },
  };
}
