/**
 * The two account tiles every identity needs – used by the quick setup, the identity page and the
 * Discord / Outlook pages. No developer apps (Azure, Discord OAuth) are needed:
 *   Microsoft: e-mail → Minecraft sign-in code confirmed in the identity's own Microsoft window,
 *              Outlook opens in the same window (same login)
 *   Discord:   own window per identity (create / sign in / open = switch), marked as set up
 */
import { api } from '../api.js';
import { codeBox, copy, guard, h, toast } from '../ui.js';
import { t } from '../i18n.js';

const tick = (ok, text) => h('div', { class: `step-line ${ok ? 'ok' : ''}` }, h('span', { class: `mark ${ok ? 'ok' : ''}` }), text);

function openWindow(path, name) {
  const w = window.open(api.downloadUrl(path), name);
  if (!w && !navigator.userAgent.includes('Electron')) toast('Popup blocked – allow popups for this page', 'error');
}

/** Opens a page in the identity's own Discord profile (desktop: separate window per identity). */
export function openDiscord(identityId, to) {
  openWindow(`/api/identities/${identityId}/discord/open?to=${to}`, `discord-${identityId}`);
}

/** Opens the identity's Microsoft window: 'link' = Minecraft confirmation (code filled in), 'outlook' = mail. */
export function openMicrosoft(identityId, to) {
  openWindow(`/api/identities/${identityId}/microsoft/open?to=${to}`, `microsoft-${identityId}`);
}

/** Sets the Microsoft account and opens the confirmation page as soon as the code is there. */
export async function microsoftSignIn(identityId, email) {
  let r = await api.post(`/api/identities/${identityId}/microsoft/connect`, { email });
  for (let i = 0; i < 40 && !r.deviceCode && r.authStatus === 'PENDING'; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const d = await api.get(`/api/identities/${identityId}`);
    r = { deviceCode: d.deviceCode, authStatus: d.minecraft?.authStatus };
  }
  if (r.deviceCode) {
    openMicrosoft(identityId, 'link');
    toast('Sign in with Microsoft in the new window and confirm – the code is already filled in', 'info', 9000);
  } else if (r.authStatus === 'AUTHENTICATED') toast('Microsoft account connected', 'ok');
}

/** Microsoft tile: Minecraft + Outlook with one login. data = /api/identities/:id */
export function microsoftTile(identityId, data, reload) {
  const ms = data.microsoft ?? { linked: false };
  const mc = data.minecraft;
  const mcOk = ms.linked && mc?.authStatus === 'AUTHENTICATED';
  const email = h('input', { type: 'email', placeholder: 'name@outlook.com', value: ms.email ?? '', autocomplete: 'off', 'aria-label': 'Microsoft e-mail' });
  const signIn = () => guard(async () => { await microsoftSignIn(identityId, email.value); await reload(); });
  return h('section', { class: 'tile' },
    h('div', { class: 'tile-head' }, h('span', { class: 'tile-icon ms' }), h('div', null, h('h2', null, 'Microsoft account'), h('div', { class: 'muted' }, ms.email ?? 'Minecraft + Outlook with one login'))),
    tick(mcOk, mcOk ? `${t('Minecraft')}: ${mc.username}` : mc?.authStatus === 'PENDING' && ms.linked ? t('Minecraft: waiting for your confirmation') : mc?.lastError && ms.linked ? `${t('Minecraft')}: ${mc.lastError}` : t('Minecraft')),
    tick(mcOk, mcOk ? `${t('Outlook')}: ${ms.email}` : t('Outlook')),
    ms.linked && data.deviceCode
      ? h('div', { class: 'infobox' },
          h('p', null, 'Confirm the sign-in in the Microsoft window. The code is filled in automatically – if not, enter it there:'),
          codeBox(data.deviceCode.userCode),
          h('div', { class: 'tile-actions' }, h('button', { class: 'primary', onclick: () => openMicrosoft(identityId, 'link') }, 'Open sign-in window')))
      : null,
    h('div', { class: 'tile-actions' },
      !ms.linked
        ? [email, h('button', { class: 'primary big', onclick: signIn }, 'Sign in with Microsoft')]
        : [
            mcOk ? h('button', { class: 'primary', title: 'Outlook in this identity\'s own window', onclick: () => openMicrosoft(identityId, 'outlook') }, 'Open Outlook') : null,
            !mcOk && !data.deviceCode ? h('button', { class: 'primary', onclick: () => guard(async () => { await microsoftSignIn(identityId, ms.email); await reload(); }) }, 'Sign in again') : null,
            h('button', { class: 'link-button', onclick: () => confirm('Disconnect the Microsoft account from this identity? Minecraft stops working until you sign in again.') && guard(async () => { await api.del(`/api/identities/${identityId}/microsoft`); await reload(); }, 'Disconnected') }, 'Disconnect'),
          ]));
}

/** Discord tile. d = discord identity row (may be null), email = identity e-mail. */
export function discordTile(identityId, d, email, reload, opts = {}) {
  const ready = d?.oauthState === 'CONNECTED';
  const helper = h('div', { class: 'copy-rows', hidden: ready && !opts.expanded });
  const fillHelper = async () => {
    const kit = await api.get(`/api/identities/${identityId}/discord/signup-kit`);
    const name = h('input', { placeholder: kit.username, 'aria-label': 'Discord username', style: { width: '180px' } });
    helper.replaceChildren(
      h('p', { class: 'muted' }, 'For the Discord sign-up form (you fill it in yourself – Discord does not allow automated sign-ups). The confirmation mail arrives in Outlook; its link opens in this identity\'s Discord window.'),
      h('div', { class: 'copy-row' }, h('span', null, 'E-mail'), h('code', null, kit.email ?? '–'), kit.email ? h('button', { class: 'small', onclick: () => copy(kit.email, 'E-mail copied') }, 'Copy') : null),
      h('div', { class: 'copy-row' }, h('span', null, 'Username'), h('code', null, kit.username), h('button', { class: 'small', onclick: () => copy(kit.username, 'Username copied') }, 'Copy')),
      h('div', { class: 'copy-row' }, h('span', null, 'Password'), h('code', null, '••••••••••'), h('button', { class: 'small', title: 'Generated once and kept in the vault – copied, never shown', onclick: () => guard(async () => { const r = await api.post(`/api/identities/${identityId}/discord/password`); await copy(r.password, 'Password copied'); }) }, 'Copy')),
      ready
        ? null
        : h('div', { class: 'tile-actions' },
            email ? h('button', { onclick: () => openMicrosoft(identityId, 'outlook') }, 'Open Outlook') : null,
            name,
            h('button', { class: 'primary', onclick: () => guard(async () => { await api.post(`/api/identities/${identityId}/discord/ready`, { username: name.value.trim() || kit.username }); await reload(); }, 'Discord set up') }, 'Done – account is set up')),
    );
  };
  if (!ready || opts.expanded) void fillHelper().catch(() => undefined);
  return h('section', { class: 'tile' },
    h('div', { class: 'tile-head' },
      h('span', { class: 'tile-icon dc' }),
      h('div', null, h('h2', null, 'Discord'), h('div', { class: 'muted' }, ready && d.username ? `@${d.username}` : 'Own Discord login for this identity'))),
    tick(ready, ready ? t('Set up') : t('Not set up yet')),
    tick(d?.linkState === 'LINKED', d?.linkState === 'LINKED' ? t('Linked on the Minecraft server') : d?.linkState === 'WAITING' ? t('Link code received – waiting for confirmation') : t('Not linked on the Minecraft server yet')),
    h('div', { class: 'tile-actions' },
      ready
        ? [
            h('button', { class: 'primary', title: 'Opens Discord logged in as this identity (separate window per identity)', onclick: () => openDiscord(identityId, 'app') }, 'Open Discord'),
            h('button', { onclick: () => { helper.hidden = !helper.hidden; if (!helper.hidden) void fillHelper(); } }, 'Sign-up data'),
          ]
        : [
            h('button', { class: 'primary big', onclick: () => { openDiscord(identityId, 'register'); helper.hidden = false; } }, 'Create Discord account'),
            h('button', { onclick: () => { openDiscord(identityId, 'login'); helper.hidden = false; } }, 'I already have one – sign in'),
          ]),
    helper);
}
