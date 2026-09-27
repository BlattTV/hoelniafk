import { api, qs } from '../api.js';
import { fmtTime, guard, h, identityName, mount, pad2, select, toast } from '../ui.js';

/** Global chat: all sessions in one stream, filterable; send to several sessions. */
export async function chatView(root) {
  const [dash, servers] = await Promise.all([api.get('/api/dashboard'), api.get('/api/servers')]);
  const names = new Map(dash.rows.map((r) => [r.id, `${identityName(r)}`]));
  const serverNames = new Map(servers.map((s) => [s.id, s.name]));
  const f = { identityId: '', serverId: '', q: '' };
  const stream = h('div', { class: 'chat-stream' });
  const targets = new Set();
  const targetBox = h('div', { class: 'toolbar', style: { margin: '8px 0' } });
  const input = h('input', { style: { flex: 1 }, placeholder: 'Message or /command to the selected sessions', maxlength: 256 });

  const line = (l) =>
    h('div', { class: 'line' },
      h('span', { class: 'muted' }, `${fmtTime(l.ts)} `),
      h('span', { class: 'who' }, `${names.get(l.identityId) ?? l.identityId}@${serverNames.get(l.serverId) ?? l.serverId} `),
      l.text);
  const visible = (l) => (!f.identityId || String(l.identityId) === f.identityId) && (!f.serverId || String(l.serverId) === f.serverId) && (!f.q || l.text.toLowerCase().includes(f.q.toLowerCase()));

  const load = async () => {
    const lines = await api.get(`/api/chat${qs({ identityId: f.identityId, serverId: f.serverId, q: f.q, limit: 400 })}`);
    mount(stream, lines.map(line));
    stream.scrollTop = stream.scrollHeight;
  };

  const renderTargets = async () => {
    const sessions = (await api.get('/api/sessions')).filter((s) => s.state === 'ONLINE');
    for (const t of [...targets]) if (!sessions.some((s) => s.id === t)) targets.delete(t);
    mount(targetBox, h('span', { class: 'muted' }, 'Send to:'),
      sessions.length
        ? sessions.map((s) => h('label', { class: 'check tag', style: { padding: '2px 6px' } }, h('input', { type: 'checkbox', checked: targets.has(s.id), onchange: (e) => (e.target.checked ? targets.add(s.id) : targets.delete(s.id)) }), `${names.get(s.identityId)}@${s.serverName}`))
        : h('span', { class: 'muted' }, 'no online sessions'),
      sessions.length ? h('button', { class: 'small', onclick: () => { sessions.forEach((s) => targets.add(s.id)); renderTargets(); } }, 'all') : null,
      sessions.length ? h('button', { class: 'small', onclick: () => { targets.clear(); renderTargets(); } }, 'none') : null);
  };

  const send = async () => {
    if (!targets.size) return toast('Select at least one online session', 'error');
    const res = await guard(() => api.post('/api/chat/send', { sessionIds: [...targets], text: input.value }));
    if (!res) return;
    const failed = res.results.filter((r) => !r.ok);
    toast(failed.length ? `${failed.length} failed: ${failed[0].error}` : `Sent to ${res.results.length} session(s)`, failed.length ? 'error' : 'ok');
    if (!failed.length) input.value = '';
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());

  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Global Chat'), h('div', { class: 'sub' }, 'Chat of all sessions (persisted). Link codes, rewards and kicks are also evaluated by the rules.'))),
    h('div', { class: 'filters' },
      select('identityId', [['', 'all identities'], ...dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`])], '', { onchange: (e) => { f.identityId = e.target.value; load(); } }),
      select('serverId', [['', 'all servers'], ...servers.map((s) => [s.id, s.name])], '', { onchange: (e) => { f.serverId = e.target.value; load(); } }),
      h('input', { type: 'search', placeholder: 'Search text…', oninput: (e) => { f.q = e.target.value; clearTimeout(input._t); input._t = setTimeout(load, 300); } })),
    stream,
    targetBox,
    h('div', { class: 'toolbar' }, input, h('button', { class: 'primary', onclick: send }, 'Send')),
  );
  await Promise.all([load(), renderTargets()]);
  let t;
  return {
    onEvent(ev) {
      if (ev.type === 'session.chat' && visible(ev.data)) {
        const atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 30;
        stream.appendChild(line(ev.data));
        while (stream.childElementCount > 1500) stream.removeChild(stream.firstChild);
        if (atBottom) stream.scrollTop = stream.scrollHeight;
      }
      if (ev.type === 'session.state') {
        clearTimeout(t);
        t = setTimeout(renderTargets, 800);
      }
    },
  };
}
