/**
 * Mail = Outlook in each identity's own Microsoft window (same login as Minecraft). No mail
 * credentials in the suite, no app registration. Optional IMAP mailboxes stay under Advanced.
 */
import { api } from '../api.js';
import { h, mount } from '../ui.js';
import { openMicrosoft } from './accounts.js';

export async function outlookView(root) {
  const render = async () => {
    const rows = await api.get('/api/discord');
    const ready = rows.filter((r) => r.microsoft?.linked);
    const missing = rows.filter((r) => !r.microsoft?.linked);
    mount(root,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Outlook'), h('div', { class: 'muted' }, `${ready.length} of ${rows.length} identities signed in with Microsoft`))),
      h('p', { class: 'lead' }, 'Each identity reads its mail in its own Outlook window – signed in with the same Microsoft login as Minecraft. Links to Discord in a mail open in that identity\'s Discord window.'),
      ready.length
        ? h('div', { class: 'account-grid' }, ready.map((r) =>
            h('button', { class: 'account-card', title: 'Open Outlook as this identity', onclick: () => openMicrosoft(r.identityId, 'outlook') },
              h('span', { class: 'tile-icon ol' }),
              h('span', { class: 'who' }, h('strong', null, r.label), h('span', { class: 'muted' }, r.microsoft.email)),
              h('span', { class: `mark ${r.minecraftStatus === 'AUTHENTICATED' ? 'ok' : 'warn'}`, title: r.minecraftStatus === 'AUTHENTICATED' ? 'Signed in' : 'Sign-in not confirmed yet' }))))
        : h('div', { class: 'empty' }, 'No identity is signed in with Microsoft yet.'),
      missing.length
        ? h('section', { class: 'card' }, h('h2', null, 'Not signed in yet'),
            h('table', null, h('tbody', null, missing.map((r) =>
              h('tr', null,
                h('td', null, h('a', { href: `#/identity/${r.identityId}` }, r.label)),
                h('td', null, h('button', { class: 'small primary', onclick: () => (location.hash = `#/new/${r.identityId}/1`) }, 'Sign in with Microsoft')))))))
        : null);
  };
  await render();
  let tm;
  return { onEvent: (ev) => { if (ev.type === 'identity.changed') { clearTimeout(tm); tm = setTimeout(render, 500); } } };
}
