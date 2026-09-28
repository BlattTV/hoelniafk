import { api } from '../api.js';
import { clear, guard, h, identityName, mount } from '../ui.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL = 0xffffff;
const range = (from, to) => { let m = 0; for (let x = from; x < to; x++) m |= 1 << x; return m; };

const PRESETS = [
  ['Always', () => Array(7).fill(ALL)],
  ['Evenings 18–24', () => Array(7).fill(range(18, 24))],
  ['Nights 0–8', () => Array(7).fill(range(0, 8))],
  ['Weekdays 8–18', () => [...Array(5).fill(range(8, 18)), 0, 0]],
  ['Weekends', () => [0, 0, 0, 0, 0, ALL, ALL]],
  ['Clear', () => Array(7).fill(0)],
];

/** 7×24 grid; click or drag to paint hours on/off. */
function grid(hours, onChange) {
  const el = h('div', { class: 'schedule-grid', role: 'grid' });
  let painting = null;
  const now = new Date();
  const today = (now.getDay() + 6) % 7;
  const draw = () => {
    clear(el);
    el.append(h('span'), ...Array.from({ length: 24 }, (_, i) => h('span', { class: 'h' }, i % 3 === 0 ? String(i) : '')));
    DAYS.forEach((d, di) => {
      el.append(h('span', { class: 'd' }, d));
      for (let hr = 0; hr < 24; hr++) {
        const on = (hours[di] >> hr) & 1;
        const set = (value) => {
          hours[di] = value ? hours[di] | (1 << hr) : hours[di] & ~(1 << hr);
          draw();
          onChange(hours);
        };
        el.append(h('span', {
          class: `c${on ? ' on' : ''}${di === today && hr === now.getHours() ? ' now' : ''}`,
          title: `${d} ${hr}:00–${hr + 1}:00`,
          onmousedown: (e) => { e.preventDefault(); painting = !on; set(painting); },
          onmouseenter: () => { if (painting !== null && !!((hours[di] >> hr) & 1) !== painting) set(painting); },
        }));
      }
    });
  };
  document.addEventListener('mouseup', () => (painting = null));
  draw();
  return el;
}

export async function schedulesView(root) {
  const head = h('div', { class: 'page-head' });
  const editor = h('section', { class: 'card sticky-card' });
  const list = h('section', { class: 'card' });
  root.append(head, h('div', { class: 'grid-2' }, editor, list));
  const selected = new Set();
  let rows = [];
  let names = new Map();
  let hours = PRESETS[1][1]();
  let enabled = true;
  const key = (r) => `${r.identityId}:${r.serverId}`;

  const renderEditor = () => {
    mount(editor,
      h('h2', null, 'Weekly window'),
      h('p', { class: 'muted' }, 'Sessions with a schedule go online at the start of a window and offline at its end (local time of this PC). A manual “Start” outside the window keeps the session online until the next window change; an open game is never cut off.'),
      h('div', { class: 'toolbar' }, PRESETS.map(([label, make]) => h('button', { class: 'small', onclick: () => { hours = make(); renderEditor(); } }, label))),
      grid(hours, (x) => (hours = x)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: enabled, onchange: (e) => (enabled = e.target.checked) }), 'Schedule active (unchecked = always online while desired)'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'primary', disabled: !selected.size, onclick: () => guard(async () => {
          const targets = rows.filter((r) => selected.has(key(r))).map((r) => ({ identityId: r.identityId, serverId: r.serverId }));
          await api.put('/api/schedules/bulk', { targets, schedule: { enabled, hours } });
          await load();
        }, `Schedule applied to ${selected.size} session(s)`) }, `Apply to ${selected.size} selected`),
        h('button', { disabled: !selected.size, onclick: () => guard(async () => {
          const targets = rows.filter((r) => selected.has(key(r))).map((r) => ({ identityId: r.identityId, serverId: r.serverId }));
          await api.put('/api/schedules/bulk', { targets, schedule: null });
          await load();
        }, 'Schedules removed') }, 'Remove schedule')));
  };

  const renderList = () => {
    const all = rows.length > 0 && rows.every((r) => selected.has(key(r)));
    mount(list,
      h('h2', null, 'Sessions'),
      rows.length
        ? h('table', null,
            h('thead', null, h('tr', null,
              h('th', null, h('input', { type: 'checkbox', checked: all, onchange: (e) => { rows.forEach((r) => (e.target.checked ? selected.add(key(r)) : selected.delete(key(r)))); renderList(); renderEditor(); } })),
              h('th', null, 'Identity'), h('th', null, 'Server'), h('th', null, 'Should be'), h('th', null, 'Schedule'))),
            h('tbody', null, rows.map((r) => h('tr', { class: selected.has(key(r)) ? 'selected' : '' },
              h('td', null, h('input', { type: 'checkbox', checked: selected.has(key(r)), onchange: (e) => { e.target.checked ? selected.add(key(r)) : selected.delete(key(r)); renderList(); renderEditor(); } })),
              h('td', null, h('a', { href: `#/identity/${r.identityId}/sessions` }, names.get(r.identityId) ?? `#${r.identityId}`)),
              h('td', null, r.serverName),
              h('td', { class: r.desiredState === 'ONLINE' ? 's-ok' : 'muted' }, r.desiredState === 'ONLINE' ? 'online' : 'offline'),
              h('td', null, r.schedule?.enabled ? h('a', { href: '#', title: 'Load into the editor', onclick: (e) => { e.preventDefault(); hours = [...r.schedule.hours]; enabled = true; renderEditor(); } }, r.text) : h('span', { class: 'muted' }, 'always')))))
          )
        : h('div', { class: 'empty' }, 'No server assignments yet.'));
  };

  const load = async () => {
    const [sch, dash] = await Promise.all([api.get('/api/schedules'), api.get('/api/dashboard')]);
    rows = sch;
    names = new Map(dash.rows.map((r) => [r.id, identityName(r)]));
    mount(head, h('div', null, h('h1', null, 'Schedules'), h('div', { class: 'sub' }, `${rows.filter((r) => r.schedule?.enabled).length} of ${rows.length} sessions have an online window`)));
    renderEditor();
    renderList();
  };
  await load();
}
