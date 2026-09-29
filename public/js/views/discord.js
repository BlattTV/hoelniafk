/** Discord: every identity's Discord account at a glance – open (= switch), create, sign in. */
import { api } from '../api.js';
import { guard, h, mount, whenIdle } from '../ui.js';
import { discordTile, openDiscord } from './accounts.js';

export async function discordView(root) {
  const render = async () => {
    const rows = await api.get('/api/discord');
    const ready = rows.filter((r) => r.discord?.oauthState === 'CONNECTED');
    mount(root,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Discord'), h('div', { class: 'muted' }, `${ready.length} of ${rows.length} identities set up`))),
      h('p', { class: 'lead' }, 'Each identity has its own Discord login in its own window. Click an account to switch to it.'),
      ready.length
        ? h('div', { class: 'account-grid' }, ready.map((r) =>
            h('button', { class: 'account-card', title: 'Open Discord as this identity', onclick: () => openDiscord(r.identityId, 'app') },
              h('span', { class: 'tile-icon dc' }),
              h('span', { class: 'who' }, h('strong', null, r.label), h('span', { class: 'muted' }, r.discord.username ? `@${r.discord.username}` : r.email ?? '')),
              h('span', { class: `mark ${r.discord.linkState === 'LINKED' ? 'ok' : 'warn'}`, title: r.discord.linkState === 'LINKED' ? 'Linked on the Minecraft server' : 'Not linked on the Minecraft server yet' }))))
        : null,
      rows.some((r) => r.discord?.oauthState !== 'CONNECTED')
        ? h('section', { class: 'card' }, h('h2', null, 'Not set up yet'),
            h('table', null, h('tbody', null, rows.filter((r) => r.discord?.oauthState !== 'CONNECTED').map((r) =>
              h('tr', null,
                h('td', null, h('a', { href: `#/identity/${r.identityId}` }, r.label), h('div', { class: 'muted' }, r.email ?? 'no mail yet')),
                h('td', null, h('div', { class: 'toolbar' },
                  h('button', { class: 'small primary', onclick: () => guard(async () => mountSetup(r)) }, 'Create / sign in'))))))))
        : null);
  };
  const mountSetup = async (r) => {
    const data = await api.get(`/api/identities/${r.identityId}`);
    const box = h('div');
    const refresh = async () => {
      const d = await api.get(`/api/identities/${r.identityId}`);
      box.replaceChildren(discordTile(r.identityId, d.discord, d.mail?.address ?? d.microsoft?.email ?? null, refresh, { expanded: true }));
    };
    box.appendChild(discordTile(r.identityId, data.discord, data.mail?.address ?? data.microsoft?.email ?? null, refresh, { expanded: true }));
    mount(root, h('div', { class: 'page-head' }, h('h1', null, `Discord – ${r.label}`), h('button', { onclick: render }, '← All Discord accounts')), h('div', { class: 'narrow' }, box));
  };
  await render();
  let tm;
  return { onEvent: (ev) => { if (ev.type === 'identity.changed' && !document.querySelector('.copy-rows:not([hidden])')) { clearTimeout(tm); tm = setTimeout(() => whenIdle(root, render), 500); } } };
}
