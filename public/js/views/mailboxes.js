import { api } from '../api.js';
import { badge, clear, field, fmtTime, formData, guard, h, identityName, modal, openExternal, pad2, select, toast, mount } from '../ui.js';
import { openMessage } from './mailviewer.js';

export async function mailboxesView(root) {
  const render = async () => {
    const [boxes, providers, dash] = await Promise.all([api.get('/api/mailboxes'), api.get('/api/alias-providers'), api.get('/api/dashboard')]);
    const identityLabel = (id) => {
      const r = dash.rows.find((x) => x.id === id);
      return r ? `#${pad2(r.number)} ${identityName(r)}` : `#${id}`;
    };
    mount(root, 
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Mailboxes & Aliases'), h('div', { class: 'sub' }, 'Real mailboxes (IMAP / OAuth2). Several identities can share one mailbox through aliases – each identity only sees mail addressed to its own address.')),
        h('div', { class: 'toolbar' }, h('button', { class: 'primary', onclick: () => addMailbox(providers, dash, render) }, 'Add mailbox'), h('button', { onclick: () => addProvider(render) }, '＋ Alias provider'))),
      boxes.length ? boxes.map((b) => mailboxCard(b, identityLabel, dash, render)) : h('div', { class: 'card empty' }, 'No mailboxes yet.'),
      h('section', { class: 'card' }, h('h2', null, 'Alias providers'),
        providers.length
          ? h('table', null, h('tbody', null, providers.map((p) => h('tr', null, h('td', null, p.label), h('td', null, h('span', { class: 'tag' }, p.kind)), h('td', { class: 'mono muted' }, JSON.stringify(p.config)), h('td', null, p.kind === 'cloudflare' ? (p.hasToken ? 'API token stored ✓' : 'no token') : 'no API needed'),
              h('td', null, h('button', { class: 'small danger', onclick: () => confirm('Remove provider?') && guard(async () => { await api.del(`/api/alias-providers/${p.id}`); await render(); }) }, '✕'))))))
          : h('p', { class: 'muted' }, 'Optional. Supported: plus addressing (user+mc01@domain, no API needed) and Cloudflare Email Routing (official API, own domain).')),
    );
  };
  await render();
}

function mailboxCard(b, identityLabel, dash, render) {
  const aliasesBox = h('div');
  const unassignedBox = h('div');
  const loadAliases = async () => {
    const aliases = await guard(() => api.get(`/api/mailboxes/${b.id}/aliases`));
    if (!aliases) return;
    const lp = h('input', { placeholder: 'mc08', style: { width: '120px' } });
    const who = select('identityId', [['', 'no identity'], ...dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`])], '');
    mount(aliasesBox, 
      h('table', null, h('tbody', null, aliases.map((a) => h('tr', null, h('td', { class: 'mono' }, a.address), h('td', { class: 'muted' }, `→ ${a.destination ?? '?'}`), h('td', null, a.identityId ? identityLabel(a.identityId) : h('span', { class: 'muted' }, 'unassigned')),
        h('td', null, !a.identityId ? h('button', { class: 'small danger', onclick: () => confirm(`Delete alias ${a.address} at the provider?`) && guard(async () => { await api.del(`/api/mailboxes/${b.id}/aliases/${encodeURIComponent(a.address)}`); await loadAliases(); }, 'Alias deleted') }, 'Delete') : null))))),
      h('div', { class: 'form-actions' }, lp, who, h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/mailboxes/${b.id}/aliases`, { localPart: lp.value, identityId: who.value ? Number(who.value) : undefined }); await loadAliases(); }, 'Alias created') }, 'Create alias')),
    );
  };
  const loadUnassigned = async () => {
    const list = await guard(() => api.get(`/api/mailboxes/${b.id}/unassigned`));
    if (!list) return;
    const candidates = b.identities.map((i) => [i.identityId, identityLabel(i.identityId)]);
    mount(unassignedBox, 
      list.length
        ? h('table', null, h('tbody', null, list.map((m) => h('tr', null,
            h('td', { class: 'mono muted' }, fmtTime(m.date)),
            h('td', { class: 'clickable', onclick: () => openMessage({ mailboxId: b.id, messageId: m.id }) }, m.subject || '(no subject)', h('div', { class: 'muted' }, `${m.from} → ${m.to.join(', ')}`)),
            h('td', null, candidates.length ? select('assign', [['', 'assign to…'], ...candidates], '', { onchange: (e) => e.target.value && guard(async () => { await api.post(`/api/messages/${m.id}/assign`, { identityId: Number(e.target.value) }); await loadUnassigned(); }, 'Mail assigned') }) : null)))))
        : h('p', { class: 'muted' }, 'No unassigned messages.'),
    );
  };
  return h('section', { class: 'card' },
    h('div', { class: 'page-head', style: { marginBottom: '8px' } },
      h('div', null, h('h1', null, b.label, ' ', h('span', { class: 'tag' }, b.kind), b.exclusiveIdentityId ? h('span', { class: 'tag' }, `exclusive: ${identityLabel(b.exclusiveIdentityId)}`) : h('span', { class: 'tag' }, 'shared')),
        h('div', { class: 'muted' }, `${b.username} · ${b.imapHost}:${b.imapPort}${b.smtpHost ? ` · SMTP ${b.smtpHost}:${b.smtpPort}` : ''}`)),
      h('div', { class: 'toolbar' },
        b.hasCredentials ? badge('ok', 'credentials in vault') : badge('error', 'no credentials'),
        b.kind === 'imap'
          ? h('button', { class: 'small', onclick: () => { const pw = prompt('IMAP password / app password (stored encrypted in the vault):'); if (pw) guard(async () => { await api.post(`/api/mailboxes/${b.id}/password`, { password: pw }); await render(); }, 'Password stored'); } }, 'Set password')
          : h('button', { class: 'small primary', onclick: () => guard(async () => { const { url } = await api.post(`/api/mailboxes/${b.id}/oauth`); openExternal(url); toast('Complete the sign-in in the new tab.', 'info', 8000); }) }, `Connect ${b.kind === 'microsoft' ? 'Microsoft' : 'Google'} (OAuth2)`),
        h('button', { class: 'small', onclick: () => guard(async () => { const r = await api.post(`/api/mailboxes/${b.id}/test`); toast(`Connection OK – ${r.total} messages, ${r.unseen} unread`, 'ok'); }) }, 'Test'),
        h('button', { class: 'small', onclick: () => guard(async () => { const r = await api.post(`/api/mailboxes/${b.id}/sync`); toast(`Synced ${r.fetched} headers`, 'ok'); await loadUnassigned(); }) }, 'Sync'),
        b.webmailUrl ? h('button', { class: 'small', onclick: () => openExternal(b.webmailUrl) }, 'Open webmail') : null,
        h('button', { class: 'small danger', onclick: () => confirm('Remove mailbox and its stored credentials?') && guard(async () => { await api.del(`/api/mailboxes/${b.id}`); await render(); }) }, 'Remove'))),
    h('div', null, h('strong', null, 'Identities: '), b.identities.length ? b.identities.map((i) => h('a', { class: 'tag', href: `#/identity/${i.identityId}` }, `${identityLabel(i.identityId)} → ${i.address}`)) : h('span', { class: 'muted' }, 'none')),
    b.aliasProviderId ? h('div', null, h('h3', null, 'Aliases'), aliasesBox, h('button', { class: 'small', onclick: loadAliases }, 'Load aliases')) : null,
    h('h3', null, 'Unassigned messages'), unassignedBox, h('button', { class: 'small', onclick: loadUnassigned }, 'Show unassigned'),
  );
}

function addMailbox(providers, dash, render) {
  const f = h('div', { class: 'form-grid' },
    field('Type', select('kind', [['imap', 'Generic IMAP'], ['microsoft', 'Microsoft (Outlook/Hotmail) – OAuth2'], ['google', 'Google (Gmail) – OAuth2']], 'imap')),
    field('Label', h('input', { name: 'label', placeholder: 'Main mailbox' })),
    field('Username / address', h('input', { name: 'username', placeholder: 'real@example.com', autocomplete: 'off' })),
    field('IMAP host (IMAP only)', h('input', { name: 'imapHost', placeholder: 'imap.example.com' })),
    field('IMAP port', h('input', { name: 'imapPort', type: 'number', value: 993 })),
    field('Password (IMAP only)', h('input', { name: 'password', type: 'password', autocomplete: 'new-password' })),
    field('SMTP host (optional)', h('input', { name: 'smtpHost' })),
    field('SMTP port', h('input', { name: 'smtpPort', type: 'number' })),
    field('Webmail URL (optional)', h('input', { name: 'webmailUrl' })),
    field('Exclusive to identity', select('exclusiveIdentityId', [['', 'shared (aliases)'], ...dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`])], '')),
    field('Alias provider', select('aliasProviderId', [['', 'none'], ...providers.map((p) => [p.id, p.label])], '')),
  );
  const m = modal('Add mailbox', h('div', null, f,
    h('p', { class: 'muted' }, 'Microsoft/Google use OAuth2 (configure the client ID under Settings). Passwords and refresh tokens are stored only in the encrypted vault.'),
    h('button', { class: 'primary', onclick: () => guard(async () => {
      const body = formData(f);
      for (const k of Object.keys(body)) if (body[k] === '' || body[k] === null) delete body[k];
      await api.post('/api/mailboxes', body);
      m.close();
      await render();
    }, 'Mailbox added') }, 'Add')));
}

function addProvider(render) {
  const f = h('div', { class: 'form-grid' },
    field('Kind', select('kind', [['plus', 'Plus addressing (user+tag@domain)'], ['cloudflare', 'Cloudflare Email Routing']], 'plus')),
    field('Label', h('input', { name: 'label' })),
    field('Base address (plus)', h('input', { name: 'baseAddress', placeholder: 'real@example.com' })),
    field('Zone ID (Cloudflare)', h('input', { name: 'zoneId' })),
    field('Domain (Cloudflare)', h('input', { name: 'domain', placeholder: 'example.com' })),
    field('API token (Cloudflare)', h('input', { name: 'apiToken', type: 'password', autocomplete: 'new-password' })),
  );
  const m = modal('Add alias provider', h('div', null, f,
    h('p', { class: 'muted' }, 'Aliases are only created through officially supported provider APIs. Cloudflare needs a token with “Email Routing Rules: Edit” and a verified destination address.'),
    h('button', { class: 'primary', onclick: () => guard(async () => {
      const b = formData(f);
      const config = b.kind === 'plus' ? { baseAddress: b.baseAddress } : { zoneId: b.zoneId, domain: b.domain };
      await api.post('/api/alias-providers', { kind: b.kind, label: b.label || b.kind, config, apiToken: b.apiToken || undefined });
      m.close();
      await render();
    }, 'Provider added') }, 'Add')));
}
