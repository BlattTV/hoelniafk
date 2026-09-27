/**
 * Identity section renderers, shared by the identity view and the setup wizard.
 * ctx = { id, data, meta: { mailboxes, servers, rules, aliasProviders }, reload }
 */
import { api, qs } from '../api.js';
import { badge, clear, codeBox, copy, field, fmtTime, formData, guard, h, modal, openExternal, select, statusIcon, toast, mount } from '../ui.js';
import { openMessage } from './mailviewer.js';

export async function loadMeta() {
  const [mailboxes, servers, rules, aliasProviders, templates] = await Promise.all([
    api.get('/api/mailboxes'),
    api.get('/api/servers'),
    api.get('/api/rules'),
    api.get('/api/alias-providers'),
    api.get('/api/templates'),
  ]);
  return { mailboxes, servers, rules, aliasProviders, templates };
}

const card = (id, title, ...children) => h('section', { class: 'card', id: `sec-${id}` }, h('h2', null, title), ...children);
const kv = (pairs) => h('div', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('div', { class: 'tree-line' }, k), h('div', null, v ?? '–')]));

// ---------------------------------------------------------------- health

export function healthSection(ctx) {
  const { health } = ctx.data;
  return card(
    'health',
    'Identity Health',
    h('div', { class: 'toolbar' }, badge(health.level), h('span', { class: `ready-banner ${health.ready ? 'ok' : 'no'}` }, health.ready ? 'READY' : 'NOT READY')),
    h(
      'ul',
      { class: 'health-list', style: { marginTop: '12px' } },
      health.checks.map((c) =>
        h(
          'li',
          { onclick: () => focusSection(c.target), title: 'Go to section' },
          h('span', null, c.label),
          h('span', { class: `s-${c.status}` }, statusIcon(c.status)),
          h('span', { class: 'muted' }, c.detail),
        ),
      ),
    ),
  );
}

export function milestoneStrip(health) {
  return h(
    'div',
    { class: 'milestone' },
    health.milestone.map((m) => h('div', { class: `step ${m.ok ? 'ok' : 'bad'}`, onclick: () => focusSection(m.target) }, `${m.label} ${m.ok ? '✓' : '✗'}`)),
  );
}

export function focusSection(target) {
  const el = document.getElementById(`sec-${target}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  } else {
    const id = location.hash.match(/\/identity\/(\d+)/)?.[1] ?? location.hash.match(/\/wizard\/(\d+)/)?.[1];
    if (id) location.hash = `#/identity/${id}/${target}`;
  }
}

// ---------------------------------------------------------------- minecraft

export function minecraftSection(ctx) {
  const { id, data } = ctx;
  const mc = data.minecraft;
  const form = h(
    'div',
    { class: 'form-grid' },
    field('Auth type', select('authType', [['microsoft', 'Microsoft account'], ['offline', 'Offline (own test server)']], mc?.authType ?? 'microsoft')),
    field('Microsoft account e-mail', h('input', { name: 'msaAccount', value: mc?.msaAccount ?? '', placeholder: 'account@outlook.com', autocomplete: 'off' })),
    field('Username', h('input', { name: 'username', value: mc?.username ?? '', placeholder: 'Player07 (updated after login)' })),
  );
  const save = () =>
    guard(async () => {
      const f = formData(form);
      if (!f.username && f.msaAccount) f.username = 'Pending_' + id;
      await api.put(`/api/identities/${id}/minecraft`, f);
      await ctx.reload();
    }, 'Minecraft account saved');
  const device = data.deviceCode
    ? h(
        'div',
        { class: 'infobox' },
        h('strong', null, 'Microsoft sign-in required'),
        h('p', null, 'Open ', h('a', { href: data.deviceCode.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, data.deviceCode.verificationUri), ' and enter:'),
        codeBox(data.deviceCode.userCode),
      )
    : null;
  return card(
    'minecraft',
    'Minecraft',
    mc
      ? kv([
          ['Username', mc.username],
          ['UUID', h('span', { class: 'mono' }, mc.uuid ?? '–')],
          ['Auth status', badge(mc.authStatus === 'AUTHENTICATED' ? 'ok' : mc.authStatus === 'ERROR' || mc.authStatus === 'EXPIRED' ? 'error' : 'warn', mc.authStatus)],
          ['Sessions', `${data.sessions.filter((s) => s.state === 'ONLINE').length}/${data.assignments.filter((a) => a.enabled).length} online`],
        ])
      : h('p', { class: 'muted' }, 'No Minecraft account configured.'),
    mc?.lastError ? h('div', { class: 'warnbox' }, mc.lastError) : null,
    device,
    form,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { onclick: save }, 'Save'),
      mc ? h('button', { class: 'primary', onclick: () => guard(async () => { const r = await api.post(`/api/identities/${id}/minecraft/auth`); if (r.deviceCode) toast('Complete the Microsoft sign-in (code shown above)', 'info', 8000); await ctx.reload(); }) }, mc.authStatus === 'AUTHENTICATED' ? 'Refresh token' : 'Authenticate') : null,
      mc?.credentialRef ? h('button', { class: 'danger', onclick: () => confirm('Remove stored Minecraft tokens?') && guard(async () => { await api.post(`/api/identities/${id}/minecraft/logout`); await ctx.reload(); }, 'Tokens removed') }, 'Remove tokens') : null,
    ),
    mc?.credentialRef ? h('p', { class: 'muted' }, 'Tokens stored at ', h('code', null, mc.credentialRef)) : null,
  );
}

// ---------------------------------------------------------------- discord

export function discordSection(ctx) {
  const { id, data } = ctx;
  const d = data.discord;
  const linked = d?.linkState === 'LINKED';
  const pending = data.pendingLink;
  const signup = () =>
    guard(async () => {
      const { url } = await api.post(`/api/identities/${id}/discord/signup`);
      openExternal(url);
      modal(
        'Create Discord Account',
        h(
          'div',
          null,
          h('p', null, 'The official Discord sign-up page was opened in your browser. The suite never creates or automates Discord accounts itself.'),
          h('ol', null, h('li', null, 'Register on discord.com (use the identity\'s mail address).'), h('li', null, 'Complete Discord\'s e-mail / phone verification (the verification mail appears in this identity\'s inbox).'), h('li', null, 'Return here and click “Connect via OAuth2”.')),
          ctx.data.mail ? h('p', null, 'Identity mail: ', h('code', null, ctx.data.mail.address), ' ', h('button', { class: 'small', onclick: () => copy(ctx.data.mail.address, 'Address copied') }, 'Copy')) : null,
          h('button', { class: 'primary', onclick: connect }, 'Connect via OAuth2'),
        ),
      );
    });
  const connect = () =>
    guard(async () => {
      const { url } = await api.post(`/api/identities/${id}/discord/connect`);
      openExternal(url);
      toast('Authorize the app in the Discord tab – this view updates automatically.', 'info', 8000);
    });
  return card(
    'discord',
    'Discord',
    d?.discordUserId
      ? h('div', { class: 'toolbar', style: { marginBottom: '10px' } }, d.avatar ? h('img', { src: d.avatar, width: 40, height: 40, style: { borderRadius: '50%' }, alt: '' }) : null, h('div', null, h('strong', null, d.displayName ?? d.username), h('div', { class: 'muted' }, `@${d.username} · ${d.discordUserId}`)))
      : null,
    kv([
      ['Account', d?.username ? `@${d.username}` : 'not connected'],
      ['Linked / Not Linked', linked ? h('span', { class: 's-ok' }, 'Linked ✓') : h('span', { class: 's-warn' }, `Not linked (${d?.linkState ?? 'UNKNOWN'})`)],
      ['OAuth status', badge(d?.oauthState === 'CONNECTED' ? 'ok' : d?.oauthState === 'PENDING' || !d || d.oauthState === 'NONE' ? 'warn' : 'error', d?.oauthState ?? 'NONE')],
      ['Last verified', fmtTime(d?.lastVerifiedAt)],
    ]),
    pending ? h('div', { class: 'infobox' }, h('strong', null, 'Link code received from the Minecraft server'), h('p', { class: 'muted' }, `${fmtTime(pending.receivedAt)} – use it in the server's Discord linking flow:`), codeBox(pending.code)) : null,
    d?.lastError ? h('div', { class: 'warnbox' }, d.lastError) : null,
    h(
      'div',
      { class: 'form-actions' },
      !d?.discordUserId ? h('button', { onclick: signup }, 'CREATE DISCORD ACCOUNT') : null,
      h('button', { class: 'primary', onclick: connect }, d?.discordUserId ? 'Reconnect via OAuth2' : 'Connect via OAuth2'),
      d?.credentialRef ? h('button', { onclick: () => guard(async () => { await api.post(`/api/identities/${id}/discord/verify`); await ctx.reload(); }, 'Discord verified') }, 'Verify') : null,
      h('button', { onclick: () => openExternal(data.discordAppUrl ?? 'https://discord.com/app') }, 'Open Discord'),
      d?.discordUserId ? h('button', { class: 'danger', onclick: () => confirm('Disconnect Discord from this identity?') && guard(async () => { await api.post(`/api/identities/${id}/discord/disconnect`); await ctx.reload(); }) }, 'Disconnect') : null,
    ),
    h(
      'div',
      { class: 'form-actions' },
      h('span', { class: 'muted' }, 'Minecraft ↔ Discord link state:'),
      select('linkState', ['UNKNOWN', 'WAITING', 'LINKED', 'ERROR'], d?.linkState ?? 'UNKNOWN', {
        onchange: (e) => guard(async () => { await api.post(`/api/identities/${id}/discord/link-state`, { state: e.target.value }); await ctx.reload(); }, 'Link state updated'),
      }),
      h('span', { class: 'muted' }, 'normally detected automatically from chat rules'),
    ),
  );
}

// ---------------------------------------------------------------- mail

export function mailSection(ctx, { withInbox = true } = {}) {
  const { id, data, meta } = ctx;
  const mail = data.mail;
  const box = data.mailbox;
  const assignForm = h(
    'div',
    { class: 'form-grid' },
    field('Mailbox', select('mailAccountId', [['', '– select –'], ...meta.mailboxes.map((m) => [m.id, `${m.label} (${m.username})`])], mail?.mailAccountId ?? '')),
    field('Address for this identity', h('input', { name: 'address', value: mail?.address ?? '', placeholder: 'mc07@example.com' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAlias', checked: mail?.isAlias }), 'is an alias'),
  );
  const aliasForm = h('div', { class: 'form-actions' });
  const renderAlias = () => {
    clear(aliasForm);
    const mbId = Number(formData(assignForm).mailAccountId);
    const mb = meta.mailboxes.find((m) => m.id === mbId);
    if (!mb?.aliasProviderId) return;
    const lp = h('input', { placeholder: 'mc07', style: { width: '120px' } });
    mount(aliasForm, 
      h('span', { class: 'muted' }, 'or create alias via provider:'),
      lp,
      h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/mailboxes/${mbId}/aliases`, { localPart: lp.value, identityId: id }); await ctx.reload(); }, 'Alias created and assigned') }, 'Create alias'),
    );
  };
  assignForm.addEventListener('change', renderAlias);
  setTimeout(renderAlias);

  const inbox = h('div');
  const filters = h(
    'div',
    { class: 'toolbar', style: { margin: '10px 0' } },
    h('input', { name: 'q', placeholder: 'Search…' }),
    h('input', { name: 'sender', placeholder: 'Sender filter' }),
    h('input', { name: 'subject', placeholder: 'Subject filter' }),
    select('category', [['', 'all categories'], ['verification-any', 'verification / account'], ['verification', 'verification'], ['security', 'security'], ['account', 'account']], ''),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'unread' }), 'unread'),
  );
  const loadInbox = async () => {
    if (!mail) return;
    const list = await guard(() => api.get(`/api/identities/${id}/mail/messages${qs(formData(filters))}`));
    if (!list) return;
    clear(inbox).appendChild(
      list.length
        ? h(
            'table',
            null,
            h('tbody', null, list.map((m) =>
              h('tr', { class: 'clickable', onclick: () => openMessage({ identityId: id, messageId: m.id, onChange: () => { loadInbox(); ctx.reload(); } }) },
                h('td', { class: 'mono muted', style: { width: '120px' } }, fmtTime(m.date)),
                h('td', { style: { width: '110px' } }, m.provider ? h('span', { class: 'tag' }, m.provider) : ''),
                h('td', { style: { fontWeight: m.seen ? 'normal' : '600' } }, m.subject || '(no subject)'),
                h('td', { class: 'muted' }, m.fromName || m.from),
              ),
            )),
          )
        : h('div', { class: 'empty' }, 'No messages (check mail to sync).'),
    );
  };
  filters.addEventListener('input', () => { clearTimeout(filters._t); filters._t = setTimeout(loadInbox, 300); });
  if (withInbox) loadInbox();

  return card(
    'mail',
    'Mail',
    mail
      ? kv([
          ['Address', h('span', null, mail.address, ' ', h('button', { class: 'small', onclick: () => copy(mail.address, 'Address copied') }, 'Copy'))],
          ['Mailbox', box ? `${box.label} (${box.kind}${box.exclusiveIdentityId ? ', exclusive' : ', shared'})` : '–'],
          ['Unread count', String(mail.unreadCount)],
          ['Access', badge(mail.accessStatus === 'OK' ? 'ok' : mail.accessStatus === 'ERROR' ? 'error' : 'warn', mail.accessStatus)],
          ['Last check', fmtTime(mail.lastCheckedAt)],
        ])
      : h('p', { class: 'muted' }, 'No mailbox assigned. Add mailboxes under “Mailboxes & Aliases”.'),
    mail?.lastError ? h('div', { class: 'warnbox' }, mail.lastError) : null,
    assignForm,
    aliasForm,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { onclick: () => guard(async () => { const f = formData(assignForm); await api.put(`/api/identities/${id}/mail`, f); await ctx.reload(); }, 'Mailbox assigned') }, 'Assign mailbox'),
      mail ? h('button', { class: 'primary', onclick: () => guard(async () => { await api.post(`/api/identities/${id}/mail/check`); await ctx.reload(); }, 'Mail checked') }, 'Check mail') : null,
      box?.webmailUrl ? h('button', { onclick: () => openExternal(box.webmailUrl) }, 'Open mailbox') : null,
      mail ? h('button', { class: 'danger', onclick: () => confirm('Unassign the mailbox from this identity?') && guard(async () => { await api.del(`/api/identities/${id}/mail`); await ctx.reload(); }) }, 'Unassign') : null,
    ),
    withInbox && mail ? h('div', null, h('h3', null, 'Inbox'), filters, inbox) : null,
  );
}

// ---------------------------------------------------------------- network

export function networkSection(ctx) {
  const { id, data } = ctx;
  const profiles = data.networkProfiles;
  const def = data.identity.networkProfileId;
  const editor = (p) => {
    const f = h(
      'div',
      { class: 'form-grid' },
      field('Name', h('input', { name: 'name', value: p?.name ?? 'default' })),
      field('Kind', select('kind', [['BIND', 'Local bind IP'], ['SOCKS5', 'SOCKS5 proxy'], ['HTTP', 'HTTP CONNECT proxy'], ['DIRECT', 'Direct']], p?.kind ?? 'BIND')),
      field('Local bind IP', h('input', { name: 'localBindIp', value: p?.localBindIp ?? '', placeholder: '192.168.1.107', list: 'iface-list' })),
      field('Proxy host', h('input', { name: 'proxyHost', value: p?.proxyHost ?? '' })),
      field('Proxy port', h('input', { name: 'proxyPort', type: 'number', value: p?.proxyPort ?? '' })),
      field('Proxy user', h('input', { name: 'proxyUsername', value: p?.proxyUsername ?? '', autocomplete: 'off' })),
      field(p?.credentialRef ? 'Proxy password (stored ✓ – leave empty)' : 'Proxy password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password' })),
      field('Expected public IP', h('input', { name: 'expectedPublicIp', value: p?.expectedPublicIp ?? '' })),
      field('Exit label', h('input', { name: 'exitLabel', value: p?.exitLabel ?? '', placeholder: 'IP #07' })),
    );
    const datalist = h('datalist', { id: 'iface-list' });
    api.get('/api/network/interfaces').then((ifs) => ifs.forEach((i) => datalist.appendChild(h('option', { value: i.address }, `${i.name} (${i.family})`)))).catch(() => {});
    modal(
      p ? `Network profile “${p.name}”` : 'New network profile',
      h('div', null, f, datalist, h('p', { class: 'muted' }, 'Profiles belong to this identity only. Passwords go to the vault and are never shown again.'),
        h('button', { class: 'primary', onclick: () => guard(async () => {
          const body = formData(f);
          if (!body.password) delete body.password;
          if (p) await api.patch(`/api/identities/${id}/network/${p.id}`, body);
          else await api.post(`/api/identities/${id}/network`, { ...body, makeDefault: !def });
          document.getElementById('modal-root').replaceChildren();
          await ctx.reload();
        }, 'Network profile saved') }, 'Save')),
    );
  };
  return card(
    'network',
    'Network',
    data.identity.settings.networkMode === 'DIRECT' ? h('p', { class: 'muted' }, 'Network mode DIRECT – no dedicated exit required.') : null,
    data.networkConflicts.length
      ? h('div', { class: 'warnbox' }, data.networkConflicts.map((c) => h('div', null, `Shares ${c.field} ${c.value} with identity ${c.otherIdentityId}`)))
      : null,
    profiles.length
      ? h('table', null,
          h('thead', null, h('tr', null, ['', 'Profile', 'Local bind IP', 'Expected public IP', 'Actual public IP', 'Connection test', ''].map((t) => h('th', null, t)))),
          h('tbody', null, profiles.map((p) =>
            h('tr', null,
              h('td', null, p.id === def ? h('span', { class: 's-ok', title: 'default' }, '★') : h('button', { class: 'small', title: 'Make default', onclick: () => guard(async () => { await api.patch(`/api/identities/${id}`, { networkProfileId: p.id }); await ctx.reload(); }) }, '☆')),
              h('td', null, `${p.name} `, h('span', { class: 'tag' }, p.kind), p.exitLabel ? h('span', { class: 'tag' }, p.exitLabel) : null, p.kind === 'SOCKS5' || p.kind === 'HTTP' ? h('div', { class: 'muted' }, `${p.proxyHost}:${p.proxyPort}`) : null),
              h('td', { class: 'mono' }, p.localBindIp ?? '–'),
              h('td', { class: 'mono' }, p.expectedPublicIp ?? '–'),
              h('td', { class: 'mono' }, p.actualPublicIp ?? '–'),
              h('td', null, badge(p.checkStatus === 'OK' ? 'ok' : p.checkStatus === 'UNKNOWN' ? 'warn' : 'error', p.checkStatus), p.lastCheckedAt ? h('div', { class: 'muted' }, fmtTime(p.lastCheckedAt)) : null, p.lastError ? h('div', { class: 's-error' }, p.lastError) : null),
              h('td', null, h('div', { class: 'toolbar' },
                h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/identities/${id}/network/verify`, { profileId: p.id }); await ctx.reload(); }, 'Connection test finished') }, 'Test'),
                h('button', { class: 'small', onclick: () => editor(p) }, 'Edit'),
                h('button', { class: 'small danger', onclick: () => confirm('Delete profile?') && guard(async () => { await api.del(`/api/identities/${id}/network/${p.id}`); await ctx.reload(); }) }, '✕'))),
            ),
          )),
        )
      : h('p', { class: 'muted' }, 'No network profile yet.'),
    h('div', { class: 'form-actions' }, h('button', { onclick: () => editor(null) }, '＋ Add profile')),
  );
}

// ---------------------------------------------------------------- servers & sessions

export function sessionsSection(ctx) {
  const { id, data, meta } = ctx;
  const byServer = new Map(data.assignments.map((a) => [a.serverId, a]));
  const sessionFor = (sid) => data.sessions.find((s) => s.serverId === sid);
  const profileOpts = [['', 'identity default'], ...data.networkProfiles.map((p) => [p.id, p.name])];
  return card(
    'sessions',
    'Minecraft Server Assignments & Sessions',
    meta.servers.length
      ? h('table', null,
          h('thead', null, h('tr', null, ['Server', 'Assigned', 'Auto start', 'Network', 'Session', ''].map((t) => h('th', null, t)))),
          h('tbody', null, meta.servers.map((s) => {
            const a = byServer.get(s.id);
            const sess = sessionFor(s.id);
            const update = (patch) => guard(async () => { await api.put(`/api/identities/${id}/servers/${s.id}`, { enabled: a?.enabled ?? true, autoStart: a?.autoStart ?? false, networkProfileId: a?.networkProfileId ?? null, ...patch }); await ctx.reload(); });
            return h('tr', null,
              h('td', null, s.name, h('div', { class: 'muted' }, `${s.host}:${s.port}`)),
              h('td', null, h('input', { type: 'checkbox', checked: !!a && a.enabled, onchange: (e) => (e.target.checked ? update({ enabled: true }) : guard(async () => { await api.del(`/api/identities/${id}/servers/${s.id}`); await ctx.reload(); })) })),
              h('td', null, a ? h('input', { type: 'checkbox', checked: a.autoStart, onchange: (e) => update({ autoStart: e.target.checked }) }) : '–'),
              h('td', null, a ? select('np', profileOpts, a.networkProfileId ?? '', { onchange: (e) => update({ networkProfileId: e.target.value ? Number(e.target.value) : null }) }) : '–'),
              h('td', null, sess ? h('span', null, badge(sess.state === 'ONLINE' ? 'ok' : sess.state === 'ERROR' ? 'error' : 'warn', sess.state), sess.lastError ? h('div', { class: 'muted', style: { maxWidth: '260px' } }, sess.lastError) : null) : h('span', { class: 'muted' }, '–')),
              h('td', null, a ? h('div', { class: 'toolbar' },
                !sess || ['STOPPED', 'ERROR', 'IDLE'].includes(sess.state)
                  ? h('button', { class: 'small primary', onclick: () => guard(async () => { await api.post(`/api/identities/${id}/sessions/${s.id}/start`); await ctx.reload(); }) }, 'Start')
                  : h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/sessions/${sess.id}/stop`); await ctx.reload(); }) }, 'Stop'),
                sess ? h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/sessions/${sess.id}/reconnect`); await ctx.reload(); }) }, 'Reconnect') : null,
                sess ? h('button', { class: 'small', onclick: () => openChat(sess, ctx) }, 'Chat') : null) : null),
            );
          })),
        )
      : h('p', { class: 'muted' }, 'No servers defined yet – add them under “Servers”.'),
  );
}

export function openChat(sess, ctx) {
  const log = h('div', { class: 'chat' });
  const add = (line) => {
    log.appendChild(h('div', null, h('span', { class: 'muted' }, `[${fmtTime(line.ts)}] `), line.text));
    log.scrollTop = log.scrollHeight;
  };
  api.get(`/api/sessions/${encodeURIComponent(sess.id)}/chat`).then((lines) => lines.forEach(add));
  const input = h('input', { style: { flex: 1 }, placeholder: 'Message or /command', maxlength: 256 });
  const send = () => guard(async () => { await api.post(`/api/sessions/${encodeURIComponent(sess.id)}/chat`, { text: input.value }); input.value = ''; });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  const m = modal(`Chat – ${sess.serverName}`, h('div', null, log, h('div', { class: 'toolbar', style: { marginTop: '8px' } }, input, h('button', { onclick: send }, 'Send'))));
  ctx.chatListener = (ev) => {
    if (!document.body.contains(m.el)) return;
    if (ev.type === 'session.chat' && ev.data.sessionId === sess.id) add(ev.data);
  };
}

// ---------------------------------------------------------------- rewards

export function rewardsSection(ctx) {
  const { id, data } = ctx;
  const r = data.rewards;
  const stars = h('input', { type: 'number', value: r.stars, style: { width: '90px' } });
  return card(
    'rewards',
    'Rewards',
    kv([
      ['Stars', h('span', { class: 'mono' }, String(r.stars))],
      ['Eligible', r.eligible ? h('span', { class: 's-ok' }, 'yes ✓') : h('span', { class: 'muted' }, 'no')],
      ['Last update', fmtTime(r.lastUpdate)],
    ]),
    h('div', { class: 'form-actions' },
      stars,
      h('button', { class: 'small', onclick: () => guard(async () => { await api.patch(`/api/identities/${id}/rewards`, { stars: Number(stars.value) }); await ctx.reload(); }, 'Stars updated') }, 'Set stars'),
      h('button', { class: 'small', onclick: () => guard(async () => { await api.patch(`/api/identities/${id}/rewards`, { eligible: !r.eligible }); await ctx.reload(); }) }, r.eligible ? 'Mark not eligible' : 'Mark eligible')),
    h('h3', null, 'History'),
    data.rewardHistory.length
      ? h('table', null, h('tbody', null, data.rewardHistory.map((e) => h('tr', null, h('td', { class: 'muted' }, fmtTime(e.ts)), h('td', { class: e.delta >= 0 ? 's-ok mono' : 's-error mono' }, e.delta >= 0 ? `+${e.delta}` : String(e.delta)), h('td', { class: 'mono' }, String(e.stars)), h('td', { class: 'muted' }, e.reason)))))
      : h('p', { class: 'muted' }, 'No reward history yet (updated from chat rules).'),
  );
}

// ---------------------------------------------------------------- settings

export function settingsSection(ctx) {
  const { id, data, meta } = ctx;
  const s = data.identity.settings;
  const parsers = meta.rules.chatRules.map((r) => r.id);
  const form = h(
    'div',
    null,
    h('div', { class: 'form-grid' },
      field('Label', h('input', { name: 'label', value: data.identity.label })),
      field('Network mode', select('networkMode', ['PER_ACCOUNT', 'SHARED', 'DIRECT'], s.networkMode)),
      field('Discord linking', select('discordLinking', ['required', 'optional', 'disabled'], s.discordLinking)),
      field('Reconnect delay (s)', h('input', { type: 'number', name: 'reconnectDelaySec', value: s.reconnectDelaySec, min: 5 })),
      field('AFK action', select('afkAction', ['none', 'look', 'swing', 'jump'], s.afk.action)),
      field('AFK interval (s)', h('input', { type: 'number', name: 'afkIntervalSec', value: s.afk.intervalSec, min: 10 })),
      field('UI color', h('input', { type: 'color', name: 'color', value: s.ui.color || '#5fb3ff' })),
      field('Tags (comma separated)', h('input', { name: 'tags', value: s.ui.tags.join(', ') })),
    ),
    h('div', { class: 'toolbar' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'autoReconnect', checked: s.autoReconnect }), 'Auto reconnect'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'afkEnabled', checked: s.afk.enabled }), 'Anti-AFK'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mailEnabled', checked: s.mailEnabled }), 'Mail enabled'),
    ),
    h('h3', null, 'Chat parsers (rules.yaml)'),
    h('div', { class: 'toolbar' }, parsers.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { parser: p }, checked: s.parsers.includes(p) }), p))),
    field('Notes', h('textarea', { name: 'notes' }, s.ui.notes ?? '')),
  );
  return card(
    'settings',
    'Identity Settings',
    form,
    h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: () => guard(async () => {
      const f = formData(form);
      const parsersSel = [...form.querySelectorAll('[data-parser]')].filter((x) => x.checked).map((x) => x.dataset.parser);
      await api.patch(`/api/identities/${id}`, {
        label: f.label,
        settings: {
          networkMode: f.networkMode,
          discordLinking: f.discordLinking,
          reconnectDelaySec: f.reconnectDelaySec,
          autoReconnect: f.autoReconnect,
          mailEnabled: f.mailEnabled,
          afk: { enabled: f.afkEnabled, action: f.afkAction, intervalSec: f.afkIntervalSec },
          parsers: parsersSel,
          ui: { color: f.color, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), notes: f.notes },
        },
      });
      await ctx.reload();
    }, 'Settings saved') }, 'Save settings')),
  );
}
