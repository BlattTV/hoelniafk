import { api } from './api.js';
import { closeGame, guard, h, identityName, openGame, toast } from './ui.js';

/**
 * Quick actions (Ctrl+K / Ctrl+P): jump anywhere, open the game of a session, start/stop,
 * check for updates. Type to filter; words match in any order.
 */
const PAGES = [
  ['Identities', '#/'], ['New identity', '#/new'], ['Discord', '#/discord'], ['Outlook', '#/mail'], ['Macros', '#/macros'], ['Sessions', '#/sessions'],
  ['Chat', '#/chat'], ['Schedules', '#/schedules'], ['Agents', '#/agents'], ['Servers', '#/servers'], ['Proxy pool', '#/proxies'],
  ['Settings & vault', '#/settings'], ['Logs', '#/logs'],
];

async function collect() {
  const items = PAGES.map(([label, hash]) => ({ label, kind: 'page', run: () => (location.hash = hash) }));
  items.push({ label: 'Toggle light / dark', kind: 'view', run: () => toggleTheme() });
  items.push({ label: 'Check for updates', kind: 'updates', run: () => guard(async () => { const st = await api.post('/api/updates/check'); toast(st.available ? `Update ${st.latest.version} available` : st.error ?? 'Up to date', st.error ? 'error' : 'ok'); }) });
  try {
    const [dash, sessions] = await Promise.all([api.get('/api/dashboard'), api.get('/api/sessions')]);
    const names = new Map(dash.rows.map((r) => [r.id, identityName(r)]));
    for (const r of dash.rows) items.push({ label: `${identityName(r)}${r.minecraft?.username ? ` (${r.minecraft.username})` : ''}`, kind: 'identity', run: () => (location.hash = `#/identity/${r.id}`) });
    for (const s of sessions) {
      const who = `${names.get(s.identityId) ?? s.identityId} @ ${s.serverName}`;
      items.push({ label: `Open game – ${who}`, kind: s.state.toLowerCase(), run: () => openGame(api, s.id) });
      if (s.runtime === 'game' || s.takeover !== 'none') items.push({ label: `Back to AFK – ${who}`, kind: 'game', run: () => closeGame(api, s.id) });
      if (s.desiredState === 'ONLINE') items.push({ label: `Stop – ${who}`, kind: 'session', run: () => guard(() => api.post(`/api/sessions/${s.id}/stop`), 'Stopping') });
      else items.push({ label: `Start – ${who}`, kind: 'session', run: () => guard(() => api.post(`/api/identities/${s.identityId}/sessions/${s.serverId}/start`), 'Starting') });
    }
  } catch {
    /* offline – pages only */
  }
  return items;
}

export function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme !== 'light'; // dark is the default
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('hoelni-theme', root.dataset.theme);
  } catch {
    /* ignore */
  }
}

let open = null;

export async function openPalette() {
  if (open) return;
  const items = await collect();
  const input = h('input', { placeholder: 'Jump to or do…  (identity, server, "open game", "stop" …)', 'aria-label': 'Quick actions' });
  const list = h('ul', { role: 'listbox' });
  const backdrop = h('div', { class: 'palette-backdrop', onclick: () => close() });
  const box = h('div', { class: 'palette', role: 'dialog' }, input, list, h('div', { class: 'hint' }, h('kbd', null, '↑'), ' ', h('kbd', null, '↓'), ' select · ', h('kbd', null, 'Enter'), ' run · ', h('kbd', null, 'Esc'), ' close'));
  let shown = [];
  let cur = 0;
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter((i) => words.every((w) => i.label.toLowerCase().includes(w))).slice(0, 60);
    cur = Math.min(cur, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((i, n) => h('li', { class: n === cur ? 'cur' : '', role: 'option', onmousemove: () => { if (cur !== n) { cur = n; render(); } }, onclick: () => run(i) }, h('span', null, i.label), h('span', { class: 'k' }, i.kind))));
    list.children[cur]?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => {
    close();
    i.run();
  };
  const close = () => {
    backdrop.remove();
    box.remove();
    open = null;
  };
  input.addEventListener('input', () => { cur = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { cur = Math.min(cur + 1, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cur = Math.max(cur - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[cur]) run(shown[cur]);
    else if (e.key === 'Escape') close();
  });
  document.body.append(backdrop, box);
  open = { close };
  render();
  input.focus();
}
