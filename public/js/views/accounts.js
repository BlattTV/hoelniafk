/**
 * The two account tiles every identity needs – used by the quick setup, the identity page and the
 * Discord page:
 *   Microsoft: ONE sign-in → Outlook mail + Minecraft
 *   Discord:   own browser profile per identity (create / sign in / open = switch) + connect
 */
import { api } from '../api.js';
import { codeBox, copy, guard, h, openExternal, toast } from '../ui.js';
import { t } from '../i18n.js';

const tick = (ok, text) => h('div', { class: `step-line ${ok ? 'ok' : ''}` }, h('span', { class: `mark ${ok ? 'ok' : ''}` }), text);

/** Opens a page in the identity's own Discord profile (desktop: separate window per identity). */
export function openDiscord(identityId, to) {
  const w = window.open(api.downloadUrl(`/api/identities/${identityId}/discord/open?to=${to}`), `discord-${identityId}`);
  if (!w && !navigator.userAgent.includes('Electron')) toast('Popup blocked – allow popups for this page', 'error');
}

export async function microsoftSignIn(identityId, loginHint) {
  const { url } = await api.post(`/api/identities/${identityId}/microsoft/connect`, loginHint ? { loginHint } : {});
  openExternal(url);
  toast('Sign in with Microsoft in the browser – this page updates by itself', 'info', 8000);
}

/** Microsoft tile: one sign-in for Outlook + Minecraft. data = /api/identities/:id */
export function microsoftTile(identityId, data, reload) {
  const ms = data.microsoft ?? { linked: false };
  const mc = data.minecraft;
  const mail = data.mail;
  const mcOk = mc?.authStatus === 'AUTHENTICATED';
  const mailOk = !!mail && (mail.accessStatus === 'OK' || (ms.linked && ms.mailboxId === mail.mailAccountId));
  return h('section', { class: 'tile' },
    h('div', { class: 'tile-head' }, h('span', { class: 'tile-icon ms' }), h('div', null, h('h2', null, 'Microsoft account'), h('div', { class: 'muted' }, ms.email ?? 'Outlook mail + Minecraft with one sign-in'))),
    tick(mailOk, mail ? `${t('Outlook mail')}: ${mail.address}` : t('Outlook mail')),
    tick(mcOk, mc && mcOk ? `${t('Minecraft')}: ${mc.username}` : mc?.authStatus === 'PENDING' ? t('Minecraft: waiting for the sign-in code') : mc?.lastError ? `${t('Minecraft')}: ${mc.lastError}` : t('Minecraft')),
    data.deviceCode
      ? h('div', { class: 'infobox' },
          h('p', null, 'Your Azure app is not approved for Minecraft yet – confirm Minecraft once with this code at ', h('a', { href: data.deviceCode.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, data.deviceCode.verificationUri), ':'),
          codeBox(data.deviceCode.userCode))
      : null,
    h('div', { class: 'tile-actions' },
      ms.linked
        ? [
            h('button', { onclick: () => guard(() => microsoftSignIn(identityId, ms.email)) }, 'Sign in again'),
            mc && !mcOk ? h('button', { onclick: () => guard(async () => { await api.post(`/api/identities/${identityId}/minecraft/auth`); await reload(); }) }, 'Retry Minecraft') : null,
            h('button', { class: 'link-button', onclick: () => confirm('Disconnect the Microsoft account from this identity? Mail and Minecraft stop working until you sign in again.') && guard(async () => { await api.del(`/api/identities/${identityId}/microsoft`); await reload(); }, 'Disconnected') }, 'Disconnect'),
          ]
        : h('button', { class: 'primary big', onclick: () => guard(() => microsoftSignIn(identityId)) }, 'Sign in with Microsoft')));
}

/** Discord tile. d = discord identity row (may be null), email = identity mail address. */
export function discordTile(identityId, d, email, reload, opts = {}) {
  const connected = d?.oauthState === 'CONNECTED';
  const helper = h('div', { class: 'copy-rows', hidden: connected && !opts.expanded });
  const fillHelper = async () => {
    const kit = await api.get(`/api/identities/${identityId}/discord/signup-kit`);
    helper.replaceChildren(
      h('p', { class: 'muted' }, 'For the Discord sign-up form (you fill it in yourself – Discord does not allow automated sign-ups):'),
      h('div', { class: 'copy-row' }, h('span', null, 'E-mail'), h('code', null, kit.email ?? '–'), kit.email ? h('button', { class: 'small', onclick: () => copy(kit.email, 'E-mail copied') }, 'Copy') : null),
      h('div', { class: 'copy-row' }, h('span', null, 'Username'), h('code', null, kit.username), h('button', { class: 'small', onclick: () => copy(kit.username, 'Username copied') }, 'Copy')),
      h('div', { class: 'copy-row' }, h('span', null, 'Password'), h('code', null, '••••••••••'), h('button', { class: 'small', title: 'Generated once and kept in the vault – copied, never shown', onclick: () => guard(async () => { const r = await api.post(`/api/identities/${identityId}/discord/password`); await copy(r.password, 'Password copied'); }) }, 'Copy')),
      h('div', { class: 'tile-actions' },
        h('button', { title: 'Opens the confirmation link from the Discord mail in this identity\'s Discord window', onclick: () => guard(async () => { await api.post(`/api/identities/${identityId}/mail/check`).catch(() => undefined); openDiscord(identityId, 'verify'); }) }, 'Open confirmation mail link'),
        h('button', { class: 'primary', onclick: () => openDiscord(identityId, 'connect') }, 'Connect to the suite')),
    );
  };
  if (!connected || opts.expanded) void fillHelper().catch(() => undefined);
  return h('section', { class: 'tile' },
    h('div', { class: 'tile-head' },
      d?.avatar && connected ? h('img', { class: 'tile-avatar', src: d.avatar, alt: '' }) : h('span', { class: 'tile-icon dc' }),
      h('div', null, h('h2', null, 'Discord'), h('div', { class: 'muted' }, connected ? `@${d.username}${d.displayName && d.displayName !== d.username ? ` (${d.displayName})` : ''}` : 'Own Discord login for this identity'))),
    tick(connected, connected ? t('Connected to the suite') : t('Not connected yet')),
    tick(d?.linkState === 'LINKED', d?.linkState === 'LINKED' ? t('Linked on the Minecraft server') : d?.linkState === 'WAITING' ? t('Link code received – waiting for confirmation') : t('Not linked on the Minecraft server yet')),
    h('div', { class: 'tile-actions' },
      connected
        ? [
            h('button', { class: 'primary', title: 'Opens Discord logged in as this identity (separate window per identity)', onclick: () => openDiscord(identityId, 'app') }, 'Open Discord'),
            h('button', { onclick: () => { helper.hidden = !helper.hidden; if (!helper.hidden) void fillHelper(); } }, 'Sign-up data'),
          ]
        : [
            h('button', { class: 'primary big', onclick: () => { openDiscord(identityId, 'register'); helper.hidden = false; } }, 'Create Discord account'),
            h('button', { onclick: () => { openDiscord(identityId, 'login'); helper.hidden = false; } }, 'I already have one – sign in'),
          ]),
    email || !connected ? helper : null);
}
