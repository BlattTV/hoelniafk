import { api } from '../api.js';
import { badge, clear, contextMenu, guard, h, identityName, mount, openExternal, openGame, pad2, select, toast } from '../ui.js';

const BULK = [
  ['startSessions', 'Set online', 'Desired state ONLINE for the selected identities (all or the chosen server)'],
  ['stopSessions', 'Set offline', 'Desired state OFFLINE – sessions are stopped'],
  ['reconnect', 'Reconnect', 'Reconnect running sessions'],
  ['checkMail', 'Check Mail', 'Sync the mailboxes of the selection'],
  ['verifyNetwork', 'Verify Network', 'Check the public exit IP of each identity'],
  ['refreshMinecraftAuth', 'Refresh MC auth', 'Refresh Microsoft/Minecraft tokens'],
  ['verifyDiscord', 'Verify Discord', 'Validate the Discord OAuth grants'],
  ['openDiscord', 'Open Discord', 'Open Discord in the browser'],
  ['openMail', 'Open Mail', 'Open the webmail of each identity'],
];

const STATE_DOT = { ONLINE: 'ok', STARTING: 'info', CONNECTING: 'info', AUTHENTICATING: 'info', RECONNECTING: 'warn', BLOCKED: 'error' };
const selected = new Set();
const state = { q: '', health: '', discord: '', sessions: '', sort: 'number', asc: true, server: '' };

function discordCell(r) {
  const d = r.discord;
  if (d.linkState === 'LINKED') return h('span', { class: 's-ok', title: `@${d.username ?? '?'} – linked on the Minecraft server` }, 'Linked');
  if (d.pendingLinkCode) return h('span', { class: 's-warn', title: 'Link code received from the server – complete the link' }, 'Code ', h('code', null, d.pendingLinkCode));
  if (d.linkState === 'WAITING') return h('span', { class: 's-warn' }, 'Waiting…');
  if (d.linkState === 'ERROR') return h('span', { class: 's-error' }, 'Link error');
  if (d.state === 'CONNECTED') return h('span', { class: 's-warn', title: `@${d.username}` }, 'Not linked');
  if (d.state === 'EXPIRED' || d.state === 'ERROR') return h('span', { class: 's-error' }, 'OAuth expired');
  return h('span', { class: 's-warn' }, 'Missing');
}

function mailCell(r) {
  if (!r.mail.address) return h('span', { class: 'muted' }, '–');
  if (r.mail.status === 'ERROR') return h('span', { class: 's-error', title: r.mail.address }, 'error');
  return h('span', { class: r.mail.unread ? '' : 'muted', title: r.mail.address }, `${r.mail.unread} unread`);
}

function exitCell(r) {
  const n = r.network;
  if (!n.status) return h('span', { class: 'muted' }, '–');
  const cls = n.status === 'OK' ? 's-ok' : n.status === 'UNKNOWN' ? 's-warn' : 's-error';
  return h('span', { class: cls, title: `actual ${n.actualIp ?? '?'} / expected ${n.expectedIp ?? '–'} (${n.status})` }, n.exitLabel ?? n.actualIp ?? '?');
}

function mcCell(r) {
  if (!r.minecraft.username) return h('span', { class: 'muted' }, 'not configured');
  return h(
    'span',
    null,
    r.minecraft.username,
    h(
      'span',
      { class: 'dots' },
      r.sessions.map((s) =>
        h('i', {
          class: s.desired === 'ONLINE' || s.state !== 'STOPPED' ? STATE_DOT[s.state] ?? '' : '',
          title: `${s.serverName}: ${s.state}${s.desired === 'ONLINE' ? ' (should be online)' : ''}${s.lastError ? `\n${s.lastError}` : ''}`,
        }),
      ),
    ),
  );
}

function matches(r) {
  if (state.q) {
    const q = state.q.toLowerCase();
    const hay = [identityName(r), r.minecraft.username, r.mail.address, r.discord.username, r.network.exitLabel, r.network.actualIp, ...r.tags].join(' ').toLowerCase();
    if (!hay.includes(q) && pad2(r.number) !== q) return false;
  }
  if (state.health && r.health !== state.health && !(state.health === 'READY' && r.ready)) return false;
  if (state.discord === 'linked' && r.discord.linkState !== 'LINKED') return false;
  if (state.discord === 'unlinked' && r.discord.linkState === 'LINKED') return false;
  if (state.sessions === 'online' && r.minecraft.online === 0) return false;
  if (state.sessions === 'problems' && !r.sessions.some((s) => ['BLOCKED', 'RECONNECTING'].includes(s.state))) return false;
  if (state.sessions === 'offline' && r.minecraft.online > 0) return false;
  return true;
}

const SORTS = {
  number: (r) => r.number,
  identity: (r) => identityName(r).toLowerCase(),
  minecraft: (r) => r.minecraft.online,
  mail: (r) => r.mail.unread,
  stars: (r) => r.stars,
  health: (r) => ({ ERROR: 0, WARNING: 1, HEALTHY: 2 })[r.health],
};

export async function dashboardView(root) {
  const head = h('div', { class: 'page-head' });
  const filters = h('div', { class: 'filters' });
  const tableWrap = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } });
  const results = h('div', { class: 'bulk-results' });
  root.append(head, filters, tableWrap, results);
  let rows = [];
  let servers = [];

  const runBulk = async (action, ids = [...selected]) => {
    if (!ids.length) return toast('Select identities first', 'error');
    const serverIds = state.server ? [Number(state.server)] : undefined;
    const res = await guard(() => api.post('/api/bulk', { action, identityIds: ids, serverIds }));
    if (!res) return;
    clear(results);
    for (const r of res.results) {
      const row = rows.find((x) => x.id === r.identityId);
      results.appendChild(h('div', { class: r.ok ? 's-ok' : 's-error' }, `${row ? identityName(row) : r.identityId}: ${r.message}`));
      if (r.url) openExternal(r.url);
    }
    load();
  };

  const renderHead = () => {
    const visible = rows.filter(matches);
    const online = rows.reduce((a, r) => a + r.minecraft.online, 0);
    const desired = rows.reduce((a, r) => a + r.minecraft.sessions, 0);
    mount(
      head,
      h('div', null, h('h1', null, 'Identities'), h('div', { class: 'sub' }, `Identities: ${rows.length} · ${rows.filter((r) => r.ready).length} ready · sessions ${online}/${desired} online · ${visible.length} shown`)),
      h('div', { class: 'toolbar' },
        h('span', { class: 'muted' }, `${selected.size} selected`),
        select('server', [['', 'all servers'], ...servers.map((s) => [s.id, s.name])], state.server, { title: 'Limit session actions to one server', onchange: (e) => (state.server = e.target.value) }),
        BULK.map(([a, label, tip]) => h('button', { class: 'small', title: tip, onclick: () => runBulk(a), disabled: !selected.size }, label)),
        h('button', { class: 'primary', onclick: () => (location.hash = '#/new') }, 'New identity')),
    );
  };

  const renderFilters = () => {
    mount(
      filters,
      h('input', { type: 'search', placeholder: 'Search name, player, mail, Discord, IP, tag…', value: state.q, oninput: (e) => { state.q = e.target.value; renderTable(); renderHead(); } }),
      select('health', [['', 'any health'], ['READY', 'ready'], ['HEALTHY', 'healthy'], ['WARNING', 'warning'], ['ERROR', 'error']], state.health, { onchange: (e) => { state.health = e.target.value; renderTable(); renderHead(); } }),
      select('discord', [['', 'any Discord'], ['linked', 'linked'], ['unlinked', 'not linked']], state.discord, { onchange: (e) => { state.discord = e.target.value; renderTable(); renderHead(); } }),
      select('sessions', [['', 'any sessions'], ['online', 'with online sessions'], ['offline', 'no session online'], ['problems', 'blocked / reconnecting']], state.sessions, { onchange: (e) => { state.sessions = e.target.value; renderTable(); renderHead(); } }),
      h('span', { class: 'muted' }, 'Right-click a row for actions'),
    );
  };

  const rowMenu = (e, r) => {
    const ids = selected.has(r.id) && selected.size > 1 ? [...selected] : [r.id];
    const many = ids.length > 1 ? ` (${ids.length})` : '';
    const online = r.sessions.find((s) => s.state === 'ONLINE') ?? r.sessions[0];
    contextMenu(e, [
      ['Open identity', () => (location.hash = `#/identity/${r.id}`)],
      ['Setup wizard', () => (location.hash = `#/wizard/${r.id}`)],
      online ? [`Open game (${online.serverName})`, () => openGame(api, online.id)] : undefined,
      null,
      [`Set all sessions online${many}`, () => runBulk('startSessions', ids)],
      [`Set all sessions offline${many}`, () => runBulk('stopSessions', ids)],
      [`Reconnect${many}`, () => runBulk('reconnect', ids)],
      null,
      [`Check mail${many}`, () => runBulk('checkMail', ids)],
      [`Verify network${many}`, () => runBulk('verifyNetwork', ids)],
      ['Network diagnosis', () => (location.hash = `#/identity/${r.id}/network`)],
      [`Open Discord${many}`, () => runBulk('openDiscord', ids)],
      [`Open mail${many}`, () => runBulk('openMail', ids)],
      null,
      ['Clone (without secrets)', () => guard(async () => { const c = await api.post(`/api/identities/${r.id}/clone`, {}); location.hash = `#/wizard/${c.id}`; })],
    ].filter((x) => x !== undefined));
  };

  const th = (label, key, tip) =>
    h('th', {
      class: key ? `sortable ${state.sort === key ? `sorted ${state.asc ? 'asc' : ''}` : ''}` : '',
      title: tip,
      onclick: key ? () => { state.asc = state.sort === key ? !state.asc : true; state.sort = key; renderTable(); } : undefined,
    }, label);

  const renderTable = () => {
    const visible = rows.filter(matches);
    const f = SORTS[state.sort] ?? SORTS.number;
    visible.sort((a, b) => (f(a) > f(b) ? 1 : f(a) < f(b) ? -1 : 0) * (state.asc ? 1 : -1));
    const all = visible.length > 0 && visible.every((r) => selected.has(r.id));
    const table = h('table', null,
      h('thead', null, h('tr', null,
        h('th', { style: { width: '32px' } }, h('input', { type: 'checkbox', checked: all, title: 'Select all shown', onchange: (e) => { visible.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); renderHead(); renderTable(); } })),
        th('#', 'number'), th('Identity', 'identity'), th('Minecraft', 'minecraft', 'Player name and one dot per assigned server (green online, amber reconnecting, red blocked)'),
        th('Discord'), th('Mail', 'mail'), th('Exit IP', null, 'Public exit IP verification'), th('Stars', 'stars'), th('Health', 'health'))),
      h('tbody', null,
        visible.length
          ? visible.map((r) =>
              h('tr', {
                class: `clickable ${selected.has(r.id) ? 'selected' : ''}`,
                onclick: (e) => { if (e.target.tagName !== 'INPUT') location.hash = `#/identity/${r.id}`; },
                oncontextmenu: (e) => rowMenu(e, r),
              },
                h('td', null, h('input', { type: 'checkbox', checked: selected.has(r.id), onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); renderHead(); renderTable(); } })),
                h('td', { class: 'num' }, pad2(r.number)),
                h('td', null, r.color ? h('span', { class: 'mark', style: { background: r.color } }) : null, identityName(r), ' ', r.tags.map((t) => h('span', { class: 'tag' }, t))),
                h('td', null, mcCell(r)),
                h('td', null, discordCell(r)),
                h('td', null, mailCell(r)),
                h('td', null, exitCell(r)),
                h('td', { class: 'mono' }, String(r.stars), r.eligible ? h('span', { class: 'tag', title: 'eligible for rewards', style: { marginLeft: '6px' } }, 'eligible') : null),
                h('td', null, badge(r.health, r.ready ? 'READY' : r.health)),
              ))
          : h('tr', null, h('td', { colspan: 9, class: 'empty' }, rows.length ? 'No identity matches the filters.' : 'No identities yet – click “New identity”.'))));
    clear(tableWrap).appendChild(table);
  };

  const load = async () => {
    const [data, srv] = await Promise.all([api.get('/api/dashboard'), api.get('/api/servers')]);
    rows = data.rows;
    servers = srv;
    for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
    renderHead();
    renderTable();
  };
  renderFilters();
  await load();

  let t;
  return {
    onEvent(ev) {
      if (['identity.changed', 'session.state', 'link.state', 'mail.updated', 'network.checked', 'reward.changed'].includes(ev.type)) {
        clearTimeout(t);
        t = setTimeout(load, 600);
      }
    },
  };
}
