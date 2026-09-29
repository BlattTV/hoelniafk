/**
 * Quick setup – a new identity in three steps:
 *   1. name + servers   2. Microsoft (Minecraft + Outlook, one login)   3. Discord   → go online
 * Everything else (network profiles, templates, rules …) stays in "Advanced".
 */
import { api } from '../api.js';
import { field, guard, h, mount, whenIdle } from '../ui.js';
import { discordTile, microsoftTile } from './accounts.js';

const STEPS = ['Name & servers', 'Microsoft', 'Discord', 'Done'];

function stepper(active, id) {
  return h('ol', { class: 'steps' },
    STEPS.map((label, i) => h('li', {
      class: `${i === active ? 'cur' : ''} ${i < active ? 'done' : ''}`,
      onclick: () => { if (id && i > 0) location.hash = `#/new/${id}/${i}`; },
    }, h('span', { class: 'n' }, String(i + 1)), label)));
}

export async function quickView(root, [idStr, stepStr]) {
  const id = idStr ? Number(idStr) : null;
  const step = id ? Math.min(Math.max(Number(stepStr ?? 1), 1), 3) : 0;

  const render = async () => {
    if (!id) {
      const servers = await api.get('/api/servers');
      const name = h('input', { placeholder: 'e.g. Main account', autofocus: true, style: { width: '100%' } });
      const boxes = servers.map((s) => h('label', { class: 'check server-choice' }, h('input', { type: 'checkbox', checked: servers.length === 1, dataset: { server: s.id } }), h('span', null, h('strong', null, s.name), h('span', { class: 'muted' }, ` ${s.host}:${s.port}`))));
      mount(root,
        h('div', { class: 'page-head' }, h('h1', null, 'New identity')),
        stepper(0, null),
        h('section', { class: 'card narrow' },
          field('Name', name),
          h('h3', null, 'Which servers should it play on?'),
          servers.length ? h('div', { class: 'server-choices' }, boxes) : h('p', { class: 'muted' }, 'No servers yet – you can add them later under Advanced → Servers.'),
          h('div', { class: 'form-actions' },
            h('button', { class: 'primary big', onclick: () => guard(async () => {
              const r = await api.post('/api/identities', { label: name.value.trim() || undefined });
              const newId = r.identity.id;
              for (const b of boxes.map((l) => l.querySelector('input')).filter((x) => x.checked)) {
                await api.put(`/api/identities/${newId}/servers/${b.dataset.server}`, { enabled: true, autoStart: false, networkProfileId: null, desiredState: 'OFFLINE' });
              }
              location.hash = `#/new/${newId}/1`;
            }) }, 'Next'))),
        h('p', { class: 'muted' }, 'Network profiles, templates and other details can be set later on the identity page (Advanced).'));
      return;
    }
    const data = await api.get(`/api/identities/${id}`);
    const next = (n) => h('button', { class: 'primary', onclick: () => (location.hash = `#/new/${id}/${n}`) }, 'Next');
    const later = (n) => h('button', { class: 'link-button', onclick: () => (location.hash = `#/new/${id}/${n}`) }, 'Skip for now');
    const head = h('div', { class: 'page-head' }, h('h1', null, data.identity.label), h('a', { href: `#/identity/${id}` }, 'Open identity page'));
    if (step === 1) {
      mount(root, head, stepper(1, id),
        h('div', { class: 'narrow' },
          h('p', { class: 'lead' }, 'Enter the Microsoft account of this identity and sign in once in its own Microsoft window. Minecraft is connected and Outlook opens in the same window – no extra setup, no app registration.'),
          microsoftTile(id, data, render),
          h('div', { class: 'form-actions' }, next(2), later(2))));
      return;
    }
    if (step === 2) {
      mount(root, head, stepper(2, id),
        h('div', { class: 'narrow' },
          h('p', { class: 'lead' }, 'Discord opens in its own window for this identity – with its own login, so several identities never mix. Create a new account or sign in to an existing one, then click “Done”.'),
          discordTile(id, data.discord, data.mail?.address ?? data.microsoft?.email ?? null, render, { expanded: false }),
          h('div', { class: 'form-actions' }, next(3), later(3))));
      return;
    }
    const mcOk = data.minecraft?.authStatus === 'AUTHENTICATED';
    const servers = data.assignments.length;
    mount(root, head, stepper(3, id),
      h('section', { class: 'card narrow' },
        h('h2', null, 'Ready'),
        h('ul', { class: 'summary' },
          h('li', { class: data.microsoft?.linked && mcOk ? 'ok' : '' }, data.microsoft?.linked && mcOk ? `Outlook: ${data.microsoft.email}` : 'Outlook: not connected'),
          h('li', { class: mcOk ? 'ok' : '' }, mcOk ? `Minecraft: ${data.minecraft.username}` : 'Minecraft: not connected'),
          h('li', { class: data.discord?.oauthState === 'CONNECTED' ? 'ok' : '' }, data.discord?.oauthState === 'CONNECTED' ? (data.discord.username ? `Discord: @${data.discord.username}` : 'Discord: set up') : 'Discord: not set up'),
          h('li', { class: servers ? 'ok' : '' }, `Servers: ${servers}`)),
        h('div', { class: 'form-actions' },
          h('button', { class: 'primary big', disabled: !mcOk || !servers, onclick: () => guard(async () => {
            await api.post('/api/bulk', { action: 'startSessions', identityIds: [id] });
            location.hash = `#/identity/${id}`;
          }, 'Going online') }, 'Go online now'),
          h('button', { onclick: () => (location.hash = `#/identity/${id}`) }, 'Open identity page'))));
  };
  await render();
  let tm;
  return { onEvent: (ev) => { if (id && ev.identityId === id && ev.type !== 'session.chat') { clearTimeout(tm); tm = setTimeout(() => whenIdle(root, render), 400); } if (id && ev.type === 'auth.devicecode' && ev.identityId === id) whenIdle(root, render); } };
}
