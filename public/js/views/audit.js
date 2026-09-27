import { api, qs } from '../api.js';
import { clear, fmtTime, h, identityName, pad2, select, mount } from '../ui.js';

export async function auditView(root) {
  const dash = await api.get('/api/dashboard');
  const names = new Map(dash.rows.map((r) => [r.id, `Identity${pad2(r.number)}`]));
  const filter = select('identityId', [['', 'all identities'], ...dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`])], '');
  const list = h('div', { class: 'card', style: { padding: 0 } });
  mount(root, 
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Audit Log'), h('div', { class: 'sub' }, 'Security-relevant actions. Tokens, passwords and full verification codes are never recorded.')), filter),
    list,
  );
  const load = async () => {
    const entries = await api.get(`/api/audit${qs({ identityId: filter.value, limit: 500 })}`);
    clear(list).appendChild(
      entries.length
        ? h('table', null, h('tbody', null, entries.map((e) => h('tr', null,
            h('td', { class: 'mono muted', style: { width: '140px' } }, fmtTime(e.ts)),
            h('td', { style: { width: '120px' } }, e.identityId ? h('a', { href: `#/identity/${e.identityId}` }, names.get(e.identityId) ?? `#${e.identityId}`) : h('span', { class: 'muted' }, 'system')),
            h('td', null, e.action),
            h('td', { class: 'muted mono' }, e.detail)))))
        : h('div', { class: 'empty' }, 'No entries.'),
    );
  };
  filter.addEventListener('change', load);
  await load();
  let t;
  return { onEvent(ev) { if (ev.type === 'audit') { clearTimeout(t); t = setTimeout(load, 500); } } };
}
