import { api } from '../api.js';
import { badge, clear, guard, h, identityName, openExternal, pad2, toast, mount } from '../ui.js';

const BULK = [
  ['checkMail', 'Check Mail'],
  ['verifyNetwork', 'Verify Network'],
  ['startSessions', 'Start Sessions'],
  ['reconnect', 'Reconnect'],
  ['stopSessions', 'Stop Sessions'],
  ['verifyDiscord', 'Verify Discord'],
  ['openDiscord', 'Open Discord'],
  ['openMail', 'Open Mail'],
];

const selected = new Set();

function discordCell(r) {
  const d = r.discord;
  if (d.linkState === 'LINKED') return h('span', { class: 's-ok' }, 'Linked ✓');
  if (d.pendingLinkCode) return h('span', { class: 's-warn' }, 'Code ', h('code', null, d.pendingLinkCode));
  if (d.linkState === 'WAITING') return h('span', { class: 's-warn' }, 'Waiting…');
  if (d.linkState === 'ERROR') return h('span', { class: 's-error' }, 'Link error ✗');
  if (d.state === 'CONNECTED') return h('span', { class: 's-warn' }, 'Not linked ⚠');
  if (d.state === 'EXPIRED' || d.state === 'ERROR') return h('span', { class: 's-error' }, 'OAuth expired ✗');
  return h('span', { class: 's-warn' }, 'Missing ⚠');
}

function mailCell(r) {
  if (!r.mail.address) return h('span', { class: 'muted' }, '–');
  if (r.mail.status === 'ERROR') return h('span', { class: 's-error' }, 'error ✗');
  return h('span', { class: r.mail.unread ? '' : 'muted', title: r.mail.address }, `${r.mail.unread} unread`);
}

function exitCell(r) {
  const n = r.network;
  if (!n.status) return h('span', { class: 'muted' }, '–');
  const cls = n.status === 'OK' ? 's-ok' : n.status === 'UNKNOWN' ? 's-warn' : 's-error';
  return h('span', { class: cls, title: `actual ${n.actualIp ?? '?'} / expected ${n.expectedIp ?? '–'}` }, n.exitLabel ?? n.actualIp ?? '?');
}

function mcCell(r) {
  if (!r.minecraft.username) return h('span', { class: 'muted' }, 'not configured');
  const { online, sessions } = r.minecraft;
  const dotCls = sessions && online === sessions ? 'on' : online ? 'partial' : '';
  return h('span', null, r.minecraft.username, h('span', { class: `dot ${dotCls}`, title: `${online}/${sessions} sessions online` }));
}

export async function dashboardView(root) {
  const head = h('div', { class: 'page-head' });
  const tableWrap = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } });
  const results = h('div', { class: 'bulk-results' });
  mount(root, head, tableWrap, results);

  let rows = [];

  const runBulk = async (action) => {
    if (!selected.size) return toast('Select identities first', 'error');
    const res = await guard(() => api.post('/api/bulk', { action, identityIds: [...selected] }));
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
    mount(head, 
      h('div', null, h('h1', null, 'Hoelni Client Suite'), h('div', { class: 'sub' }, `Identities: ${rows.length} · ${rows.filter((r) => r.ready).length} ready`)),
      h(
        'div',
        { class: 'toolbar' },
        h('span', { class: 'muted' }, `${selected.size} selected`),
        BULK.map(([a, label]) => h('button', { class: 'small', onclick: () => runBulk(a), disabled: !selected.size }, label)),
        h('button', { class: 'primary', onclick: () => (location.hash = '#/wizard') }, '＋ New Identity'),
      ),
    );
  };

  const renderTable = () => {
    const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
    const table = h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: { width: '32px' } }, h('input', { type: 'checkbox', checked: all, onchange: (e) => { rows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); renderHead(); renderTable(); } })),
          ['#', 'Identity', 'Minecraft', 'Discord', 'Mail', 'Exit IP', 'Stars', 'Health'].map((t) => h('th', null, t)),
        ),
      ),
      h(
        'tbody',
        null,
        rows.length
          ? rows.map((r) =>
              h(
                'tr',
                { class: `clickable ${selected.has(r.id) ? 'selected' : ''}`, onclick: (e) => { if (e.target.tagName !== 'INPUT') location.hash = `#/identity/${r.id}`; } },
                h('td', null, h('input', { type: 'checkbox', checked: selected.has(r.id), onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); renderHead(); renderTable(); } })),
                h('td', { class: 'num' }, pad2(r.number)),
                h('td', null, r.color ? h('span', { style: { color: r.color } }, '■ ') : null, identityName(r), ' ', r.tags.map((t) => h('span', { class: 'tag' }, t))),
                h('td', null, mcCell(r)),
                h('td', null, discordCell(r)),
                h('td', null, mailCell(r)),
                h('td', null, exitCell(r)),
                h('td', { class: 'mono' }, String(r.stars), r.eligible ? h('span', { class: 's-ok', title: 'eligible' }, ' ★') : null),
                h('td', null, badge(r.health, r.ready ? 'READY' : r.health)),
              ),
            )
          : h('tr', null, h('td', { colspan: 9, class: 'empty' }, 'No identities yet – create one with the setup wizard.')),
      ),
    );
    clear(tableWrap).appendChild(table);
  };

  const load = async () => {
    const data = await api.get('/api/dashboard');
    rows = data.rows;
    for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
    renderHead();
    renderTable();
  };
  await load();

  let t;
  return {
    onEvent(ev) {
      if (['identity.changed', 'session.state', 'link.state', 'mail.updated', 'network.checked', 'reward.changed'].includes(ev.type)) {
        clearTimeout(t);
        t = setTimeout(load, 400);
      }
    },
  };
}
