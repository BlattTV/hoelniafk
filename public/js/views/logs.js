import { api, qs } from '../api.js';
import { fmtTime, h, mount, select } from '../ui.js';

export async function logsView(root) {
  const f = { level: 'info', scope: '', q: '', sessionId: '' };
  const body = h('tbody');
  const live = { on: true };
  const row = (e) => h('tr', { class: `log-row ${e.level}` },
    h('td', { class: 'mono muted', style: { whiteSpace: 'nowrap' } }, fmtTime(e.ts)),
    h('td', null, e.level),
    h('td', null, e.scope),
    h('td', { class: 'mono muted' }, e.sessionId ?? (e.identityId ? `#${e.identityId}` : '')),
    h('td', { style: { wordBreak: 'break-word' } }, e.msg));
  const load = async () => {
    const entries = await api.get(`/api/logs${qs({ ...f, limit: 500 })}`);
    mount(body, entries.map(row));
  };
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Logs'), h('div', { class: 'sub' }, 'Structured application log (also written as JSON lines to data/logs/hoelni.log). Secrets are redacted.'))),
    h('div', { class: 'filters' },
      select('level', ['debug', 'info', 'warn', 'error'], f.level, { onchange: (e) => { f.level = e.target.value; load(); } }),
      h('input', { placeholder: 'scope (e.g. runtime, sessions, mail)', oninput: (e) => { f.scope = e.target.value.trim(); load(); } }),
      h('input', { placeholder: 'session id (e.g. 3:1)', oninput: (e) => { f.sessionId = e.target.value.trim(); load(); } }),
      h('input', { type: 'search', placeholder: 'search text', oninput: (e) => { f.q = e.target.value; load(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (live.on = e.target.checked) }), 'live (warn/error)'),
      h('button', { class: 'small', onclick: load }, 'Refresh')),
    h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, h('table', null, h('thead', null, h('tr', null, ['Time', 'Level', 'Scope', 'Context', 'Message'].map((t) => h('th', null, t)))), body)));
  await load();
  return {
    onEvent(ev) {
      if (ev.type === 'log' && live.on) body.insertBefore(row(ev.data), body.firstChild);
    },
  };
}
