import { api } from '../api.js';
import { badge, clear, field, fmtTime, formData, guard, h, identityName, pad2, mount } from '../ui.js';
import { openChat } from './sections.js';

export async function serversView(root) {
  const render = async () => {
    const servers = await api.get('/api/servers');
    const f = h('div', { class: 'form-grid' },
      field('Name', h('input', { name: 'name', placeholder: 'SMP' })),
      field('Host', h('input', { name: 'host', placeholder: 'mc.example.com' })),
      field('Port', h('input', { name: 'port', type: 'number', value: 25565 })),
      field('Version (empty = auto)', h('input', { name: 'version', placeholder: '1.21.4' })));
    mount(root, 
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Minecraft Servers'), h('div', { class: 'sub' }, 'Your own servers / test environments. Identities are assigned per server; each identity can run sessions on several servers at once.'))),
      h('section', { class: 'card' },
        servers.length
          ? h('table', null, h('thead', null, h('tr', null, ['Name', 'Host', 'Port', 'Version', ''].map((t) => h('th', null, t)))),
              h('tbody', null, servers.map((s) => h('tr', null, h('td', null, s.name), h('td', { class: 'mono' }, s.host), h('td', { class: 'mono' }, String(s.port)), h('td', null, s.version ?? 'auto'),
                h('td', null, h('button', { class: 'small danger', onclick: () => confirm(`Delete server ${s.name}? Assignments are removed.`) && guard(async () => { await api.del(`/api/servers/${s.id}`); await render(); }) }, '✕'))))))
          : h('p', { class: 'muted' }, 'No servers yet.')),
      h('section', { class: 'card' }, h('h2', null, 'Add server'), f,
        h('button', { class: 'primary', onclick: () => guard(async () => { const b = formData(f); if (!b.version) b.version = null; await api.post('/api/servers', b); await render(); }, 'Server saved') }, 'Save')),
    );
  };
  await render();
}

/** Session Manager: all sessions grouped by server. */
export async function sessionsView(root) {
  const ctx = { chatListener: null };
  const render = async () => {
    const [sessions, servers, dash] = await Promise.all([api.get('/api/sessions'), api.get('/api/servers'), api.get('/api/dashboard')]);
    const name = (id) => { const r = dash.rows.find((x) => x.id === id); return r ? `#${pad2(r.number)} ${identityName(r)}` : `#${id}`; };
    mount(root, 
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Session Manager'), h('div', { class: 'sub' }, `${sessions.filter((s) => s.state === 'ONLINE').length}/${sessions.length} online`))),
      servers.map((srv) => {
        const list = sessions.filter((s) => s.serverId === srv.id);
        return h('section', { class: 'card' }, h('h2', null, `${srv.name} sessions (${list.length})`),
          list.length
            ? h('table', null, h('tbody', null, list.map((s) => h('tr', null,
                h('td', null, h('a', { href: `#/identity/${s.identityId}/sessions` }, name(s.identityId))),
                h('td', null, badge(s.state === 'ONLINE' ? 'ok' : s.state === 'ERROR' ? 'error' : 'warn', s.state)),
                h('td', { class: 'muted' }, `since ${fmtTime(s.since)} · reconnects ${s.reconnects}`),
                h('td', { class: 'muted' }, s.lastError ?? ''),
                h('td', null, h('div', { class: 'toolbar' },
                  h('button', { class: 'small', onclick: () => openChat(s, ctx) }, 'Chat'),
                  h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/sessions/${s.id}/reconnect`); await render(); }) }, 'Reconnect'),
                  h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/sessions/${s.id}/stop`); await render(); }) }, 'Stop')))))))
            : h('p', { class: 'muted' }, 'No sessions.'));
      }),
    );
  };
  await render();
  let t;
  return {
    onEvent(ev) {
      if (ctx.chatListener) ctx.chatListener(ev);
      if (ev.type === 'session.state' && !document.getElementById('modal-root').childElementCount) { clearTimeout(t); t = setTimeout(render, 400); }
    },
  };
}
