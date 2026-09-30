/**
 * Logins – the account library: Microsoft and Discord accounts added on their own (each with its own
 * window / browser profile) and linked to identities by hand. Linking an account that belongs to
 * another identity moves it there; the Minecraft login moves with it.
 */
import { api } from '../api.js';
import { badge, guard, h, identityName, patch, toast, whenIdle } from '../ui.js';
import { t } from '../i18n.js';

function openAccount(id, to) {
  const w = window.open(api.downloadUrl(`/api/accounts/${id}/open?to=${to}`), `account-${id}`);
  if (!w && !navigator.userAgent.includes('Electron')) toast('Popup blocked – allow popups for this page', 'error');
}

const MC_STATUS = { AUTHENTICATED: ['ok', 'Minecraft signed in'], PENDING: ['warn', 'Minecraft: waiting for confirmation'], ERROR: ['error', 'Minecraft sign-in failed'], NONE: ['skipped', 'Minecraft not signed in yet'] };

export async function loginsView(root) {
  let accounts = [];
  let identities = [];

  const identitySelect = (a) => {
    const taken = new Map(accounts.filter((x) => x.kind === a.kind && x.identityId !== null && x.id !== a.id).map((x) => [x.identityId, x]));
    const sel = h('select', {
      'aria-label': 'Linked identity',
      'data-for': `${a.id}:${a.identityId ?? ''}:${[...taken.keys()].join(',')}`,
      onchange: (e) => {
        const target = e.target.value ? Number(e.target.value) : null;
        const other = target !== null ? taken.get(target) : null;
        if (other && !confirm(t(`This identity already has an account of this kind – it goes back to the library. Continue?`))) {
          e.target.value = a.identityId ?? '';
          return;
        }
        void guard(async () => {
          await api.post(`/api/accounts/${a.id}/link`, { identityId: target });
          await load();
        }, target === null ? 'Unlinked – the account stays in the library' : 'Linked');
      },
    },
      h('option', { value: '' }, '– not linked –'),
      identities.map((i) => h('option', { value: String(i.id), selected: i.id === a.identityId }, `${identityName(i)}${taken.has(i.id) ? ` (${t('has one')})` : ''}`)));
    return sel;
  };

  const row = (a) => {
    const ms = a.kind === 'microsoft';
    const [kind, text] = ms ? (a.identityId !== null ? MC_STATUS[a.minecraftStatus ?? 'NONE'] ?? MC_STATUS.NONE : a.ready ? ['ok', 'Signed in before'] : ['skipped', 'Not linked']) : a.ready ? ['ok', 'Set up'] : ['warn', 'Not set up yet'];
    return h('tr', { 'data-key': String(a.id) },
      h('td', null,
        h('strong', null, a.label || (ms ? a.email : a.username ? `@${a.username}` : `Discord #${a.id}`)),
        a.label && ms ? h('div', { class: 'muted' }, a.email) : null,
        !ms && a.label && a.username ? h('div', { class: 'muted' }, `@${a.username}`) : null,
        ms && a.username ? h('div', { class: 'muted' }, `${t('Minecraft')}: ${a.username}`) : null),
      h('td', null, badge(kind, text)),
      h('td', null, identitySelect(a)),
      h('td', null, h('div', { class: 'toolbar' },
        ms
          ? [
              h('button', { class: 'small primary', title: 'Outlook in this account\'s own window', onclick: () => openAccount(a.id, 'outlook') }, 'Outlook'),
              h('button', { class: 'small', title: 'Sign in to Microsoft in this account\'s window', onclick: () => openAccount(a.id, 'login') }, 'Sign in'),
            ]
          : [
              h('button', { class: 'small primary', title: 'Discord logged in as this account (own window)', onclick: () => openAccount(a.id, a.ready ? 'app' : 'login') }, a.ready ? 'Open Discord' : 'Sign in'),
              a.ready ? null : h('button', { class: 'small', onclick: () => openAccount(a.id, 'register') }, 'Create account'),
              a.ready ? null : h('button', { class: 'small', title: 'After signing in / registering in its window', onclick: () => guard(async () => { await api.patch(`/api/accounts/${a.id}`, { ready: true }); await load(); }, 'Discord set up') }, 'Done – set up'),
            ],
        h('button', { class: 'small', onclick: () => rename(a) }, 'Rename'),
        h('button', { class: 'small danger', onclick: () => confirm(t('Remove this account from the library? Its login in the window is not deleted at Microsoft/Discord.')) && guard(async () => { await api.del(`/api/accounts/${a.id}`); await load(); }, 'Removed') }, 'Remove'))));
  };

  const rename = (a) => {
    const label = prompt(t('Name for this account (only shown here)'), a.label || '');
    if (label === null) return;
    const username = a.kind === 'discord' ? prompt(t('Discord username (optional)'), a.username || '') : undefined;
    void guard(async () => {
      await api.patch(`/api/accounts/${a.id}`, { label, ...(username !== undefined && username !== null ? { username } : {}) });
      await load();
    }, 'Saved');
  };

  const addForm = (kind) => {
    const email = kind === 'microsoft' ? h('input', { type: 'email', placeholder: 'name@outlook.com', 'aria-label': 'Microsoft e-mail', autocomplete: 'off' }) : null;
    const label = h('input', { placeholder: kind === 'microsoft' ? 'Name (optional)' : 'Name (optional), e.g. Alt 3', 'aria-label': 'Name', autocomplete: 'off' });
    const user = kind === 'discord' ? h('input', { placeholder: 'Discord username (optional)', 'aria-label': 'Discord username', autocomplete: 'off' }) : null;
    const add = () => guard(async () => {
      const a = await api.post('/api/accounts', { kind, email: email?.value, label: label.value, username: user?.value });
      if (email) email.value = '';
      label.value = '';
      if (user) user.value = '';
      await load();
      openAccount(a.id, kind === 'microsoft' ? 'login' : 'register');
    }, kind === 'microsoft' ? 'Added – sign in in the new window' : 'Added – create or sign in in the new window');
    return h('div', { class: 'toolbar add-account' }, email, label, user, h('button', { class: 'primary', onclick: add }, kind === 'microsoft' ? 'Add Microsoft account' : 'Add Discord account'));
  };

  const card = (kind, title, hint) => {
    const list = accounts.filter((a) => a.kind === kind);
    return h('section', { class: 'card', 'data-key': kind },
      h('h2', null, title),
      h('p', { class: 'muted' }, hint),
      list.length
        ? h('table', null,
            h('thead', null, h('tr', null, ['Account', 'State', 'Identity', ''].map((x) => h('th', null, x)))),
            h('tbody', null, list.map(row)))
        : h('p', { class: 'muted' }, kind === 'microsoft' ? 'No Microsoft account yet.' : 'No Discord account yet.'));
  };

  const body = h('div');
  const forms = h('div', { class: 'card' },
    h('h2', null, 'Add'),
    h('p', { class: 'muted' }, 'Each account gets its own window with its own login. Add it here, sign in there, then link it to an identity – or link it later.'),
    addForm('microsoft'),
    addForm('discord'));

  const load = async () => {
    const [acc, dash] = await Promise.all([api.get('/api/accounts'), api.get('/api/dashboard')]);
    accounts = acc;
    identities = dash.rows;
    patch(body,
      card('microsoft', 'Microsoft accounts', 'Minecraft and Outlook with one login. Linking moves the Minecraft login to the identity – sessions of that identity use it.'),
      card('discord', 'Discord accounts', 'Own Discord login per account. The suite never automates Discord – you register and sign in yourself in the account\'s window.'));
  };

  patch(root,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Logins'), h('div', { class: 'sub' }, 'Microsoft and Discord accounts – add them on their own and link them to identities'))),
    forms,
    body);
  await load();
  let tm;
  return {
    onEvent: (ev) => {
      if (ev.type === 'accounts.changed' || ev.type === 'identity.changed') {
        clearTimeout(tm);
        tm = setTimeout(() => whenIdle(root, load), 400);
      }
    },
  };
}

/** Small picker for the identity tiles: link an account from the library (moves it here). */
export function libraryPicker(kind, identityId, reload) {
  const sel = h('select', { class: 'small', 'aria-label': 'Link an account from the library' }, h('option', { value: '' }, kind === 'microsoft' ? 'Link a Microsoft account from the library…' : 'Link a Discord account from the library…'));
  void api.get('/api/accounts').then((list) => {
    const options = list.filter((a) => a.kind === kind && a.identityId !== identityId);
    if (!options.length) {
      sel.hidden = true;
      return;
    }
    for (const a of options) sel.appendChild(h('option', { value: String(a.id) }, `${a.label || a.email || (a.username ? `@${a.username}` : `#${a.id}`)}${a.identityLabel ? ` (${t('now')}: ${a.identityLabel})` : ''}`));
  }).catch(() => (sel.hidden = true));
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const a = sel.options[sel.selectedIndex].textContent;
    if (!confirm(`${t('Link this account to the identity?')}\n${a}`)) {
      sel.value = '';
      return;
    }
    void guard(async () => {
      await api.post(`/api/accounts/${sel.value}/link`, { identityId });
      await reload();
    }, 'Linked');
  });
  return sel;
}
