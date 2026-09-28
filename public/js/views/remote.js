/**
 * Backend (afk.hoelni.de) integration in the manager:
 *  - Settings card "Backend & account": sign-in, address (change needs an admin), backend proxy
 *  - Agents page: PCs in other households signed in with the same account
 *  - Accounts page: account administration, shown ONLY when signed in as admin
 */
import { api } from '../api.js';
import { field, fmtTime, guard, h, modal, mount, relTime } from '../ui.js';

const STATE_TEXT = {
  'signed-out': ['skipped', 'signed out'],
  connecting: ['info', 'connecting…'],
  online: ['ok', 'connected'],
  offline: ['warn', 'offline – retrying'],
  replaced: ['error', 'another manager of this account took over'],
};

export function backendStateBadge(st) {
  const [cls, text] = STATE_TEXT[st.state] ?? ['unknown', st.state];
  return h('span', { class: `badge ${cls}`, title: st.lastError ?? '' }, text);
}

/** First sign-in with a self-signed certificate: confirm its fingerprint once. */
async function confirmCertificate() {
  const cert = await api.post('/api/backend/certificate');
  if (!cert || cert.trusted) return null;
  return new Promise((resolve, reject) => {
    let dlg = null;
    const done = (fn) => { dlg?.close(); fn(); };
    dlg = modal('Confirm the backend certificate', h('div', null,
      h('p', null, 'The backend uses its own (self-signed) certificate. Compare the fingerprint with the one shown on the backend (', h('code', null, 'hoelni-backend info'), '). The manager will then only accept exactly this certificate.'),
      h('div', { class: 'kv' }, h('div', null, 'Subject'), h('div', { class: 'mono' }, cert.subject), h('div', null, 'Valid until'), h('div', null, cert.validTo)),
      h('p', null, h('code', { style: { fontSize: '14px', wordBreak: 'break-all' } }, cert.fingerprint256)),
      h('div', { class: 'form-actions' },
        h('button', { class: 'primary', onclick: () => done(() => resolve(cert.pem)) }, 'Fingerprint matches – trust it'),
        h('button', { onclick: () => done(() => reject(new Error('Not signed in – certificate not confirmed'))) }, 'Cancel'))));
  });
}

function changeAddressDialog(st, rerender) {
  const url = h('input', { value: st.url, placeholder: 'https://afk.hoelni.de', style: { width: '100%' } });
  const user = h('input', { autocomplete: 'username', style: { width: '100%' } });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', style: { width: '100%' } });
  const dlg = modal('Change backend address', h('div', null,
    h('p', { class: 'muted' }, `Only an admin of the current backend (${st.url}) can change the address. You will be signed out and sign in at the new backend afterwards.`),
    h('div', { class: 'form-grid' }, field('New address', url), field('Admin username', user), field('Admin password', pw)),
    h('div', { class: 'form-actions' },
      h('button', { class: 'primary', onclick: () => guard(async () => {
        await api.post('/api/backend/change', { url: url.value, adminUser: user.value, adminPassword: pw.value });
        pw.value = '';
        dlg.close();
        await rerender();
      }, 'Backend address changed – sign in again') }, 'Change address'),
      h('button', { onclick: () => guard(async () => {
        await api.post('/api/backend/change', { url: 'https://afk.hoelni.de', adminUser: user.value, adminPassword: pw.value });
        pw.value = '';
        dlg.close();
        await rerender();
      }, 'Reset to afk.hoelni.de') }, 'Reset to default'))));
}

/** Settings → "Backend & account". */
export function backendCard(st, rerender) {
  const user = h('input', { value: st.username ?? '', autocomplete: 'username', style: { width: '100%' } });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', style: { width: '100%' } });
  const proxy = h('input', { value: st.proxy, placeholder: 'socks5://user:pass@host:1080 or http://host:3128 (empty = direct)', style: { width: '100%' } });
  const signedIn = st.state !== 'signed-out';
  const login = () => guard(async () => {
    const trustCert = st.pinnedCert ? null : await confirmCertificate();
    await api.post('/api/backend/login', { username: user.value, password: pw.value, trustCert });
    pw.value = '';
    await rerender();
    location.hash = location.hash; // nav (admin entry) refreshes via the agents.changed event
  }, 'Signed in');
  return h('section', { class: 'card', id: 'backend-card' },
    h('h2', null, 'Backend & account'),
    h('div', { class: 'kv' },
      h('div', null, 'Address'), h('div', { class: 'mono' }, st.url, st.isDefault ? h('span', { class: 'muted' }, ' (default)') : null),
      h('div', null, 'Connection'), h('div', null, backendStateBadge(st), st.lastError && st.state !== 'online' ? h('span', { class: 'muted' }, ` ${st.lastError}`) : null),
      h('div', null, 'Account'), h('div', null, signedIn && st.username ? `${st.username}${st.role === 'admin' ? ' · admin' : ''}` : '–'),
      h('div', null, 'Certificate'), h('div', null, st.pinnedCert ? 'own certificate (pinned)' : 'public CA'),
      h('div', null, 'Agents online'), h('div', null, String(st.agents.filter((a) => a.online).length))),
    signedIn
      ? h('div', { class: 'form-actions' },
          h('button', { onclick: () => guard(async () => { await api.post('/api/backend/logout'); await rerender(); }, 'Signed out') }, 'Sign out'),
          h('a', { class: 'btn-link', href: '#/agents' }, 'Show agents'))
      : h('div', null,
          h('div', { class: 'form-grid' }, field('Username', user), field('Password', pw)),
          h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: login }, 'Sign in'))),
    h('h3', null, 'Connection to the backend'),
    h('div', { class: 'form-grid' }, field('Proxy (optional)', proxy)),
    h('div', { class: 'form-actions' },
      h('button', { onclick: () => guard(async () => { await api.put('/api/backend/proxy', { proxy: proxy.value }); await rerender(); }, 'Saved') }, 'Save proxy'),
      h('button', { title: 'Needs an admin account of the current backend', onclick: () => changeAddressDialog(st, rerender) }, 'Change address…')),
    h('p', { class: 'muted' }, 'Accounts live on the backend. Sign in here and in the Hoelni Agent on other PCs with the same account – those PCs then appear under Agents and can run sessions of your identities ("Run on" in the identity settings). Passwords are never stored; the manager keeps only a device token in the vault.'));
}

// ---------------------------------------------------------------- Agents page

export async function agentsView(root) {
  const render = async () => {
    const [st, agents, sessions] = await Promise.all([api.get('/api/backend'), api.get('/api/backend/agents'), api.get('/api/sessions').catch(() => [])]);
    const sessionName = (sid) => {
      const s = sessions.find((x) => x.id === sid);
      return s ? `${s.username ?? sid} @ ${s.serverName}` : sid;
    };
    mount(root,
      h('div', { class: 'page-head' }, h('h1', null, 'Agents'), h('div', { class: 'toolbar' }, backendStateBadge(st), h('span', { class: 'muted' }, st.username ? `account ${st.username}` : ''))),
      st.state === 'signed-out'
        ? h('section', { class: 'card' }, h('p', null, 'Not signed in to the backend.'), h('a', { class: 'btn-link', href: '#/settings' }, 'Sign in under Settings'))
        : agents.length
          ? h('section', { class: 'card' }, h('table', null,
              h('thead', null, h('tr', null, ['Agent', 'State', 'Sessions here', 'Address', 'System', 'Last seen'].map((t) => h('th', null, t)))),
              h('tbody', null, agents.map((a) => h('tr', null,
                h('td', null, h('strong', null, a.name), h('div', { class: 'muted mono' }, `#${a.id}`)),
                h('td', null, !a.online ? h('span', { class: 'badge skipped' }, 'offline') : a.paused ? h('span', { class: 'badge warn', title: 'Paused on that PC – no sessions start there' }, 'paused by household') : h('span', { class: 'badge ok' }, 'online')),
                h('td', null, a.sessions.length ? a.sessions.map((sid) => h('div', null, sessionName(sid))) : h('span', { class: 'muted' }, '–')),
                h('td', { class: 'mono' }, a.ip ?? '–'),
                h('td', { class: 'muted' }, [a.info?.hostname, a.info?.os, a.info?.version ? `agent ${a.info.version}` : null].filter(Boolean).join(' · ') || '–'),
                h('td', { class: 'muted' }, a.online ? `since ${relTime(a.connectedAt)}` : relTime(a.lastSeenAt)))))))
          : h('section', { class: 'card' }, h('p', null, 'No agent signed in yet.'),
              h('p', { class: 'muted' }, 'Install "Hoelni Agent" on the other PC and sign in with this account. It then shows up here; choose it under an identity → Identity Settings → "Run on".')),
      h('p', { class: 'muted' }, 'An agent can only run the sessions you assign to it (start/stop, chat, game window). It cannot run commands or access files on that PC; the household can pause it at any time.'));
  };
  await render();
  let t;
  return { onEvent: (ev) => { if (ev.type === 'agents.changed' || ev.type === 'session.state') { clearTimeout(t); t = setTimeout(render, 500); } } };
}

// ---------------------------------------------------------------- Accounts page (admins only)

function newUserDialog(rerender) {
  const name = h('input', { autocomplete: 'off', style: { width: '100%' } });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
  const role = h('select', null, h('option', { value: 'user' }, 'User'), h('option', { value: 'admin' }, 'Admin'));
  const dlg = modal('New account', h('div', null,
    h('div', { class: 'form-grid' }, field('Username', name), field('Password (min. 10 characters)', pw), field('Role', role)),
    h('p', { class: 'muted' }, 'Give the person the username and password personally. They sign in to their manager or agent with it.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: () => guard(async () => {
      await api.post('/api/backend/admin/users', { username: name.value.trim(), password: pw.value, role: role.value });
      pw.value = '';
      dlg.close();
      await rerender();
    }, 'Account created') }, 'Create'))));
}

function passwordDialog(u, rerender) {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
  const dlg = modal(`New password for ${u.username}`, h('div', null,
    field('Password (min. 10 characters)', pw),
    h('p', { class: 'muted' }, 'All managers and agents of this account are signed out and must sign in again.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: () => guard(async () => {
      await api.patch(`/api/backend/admin/users/${u.id}`, { password: pw.value });
      pw.value = '';
      dlg.close();
      await rerender();
    }, 'Password changed') }, 'Set password'))));
}

export async function accountsView(root) {
  const render = async () => {
    const st = await api.get('/api/backend');
    if (st.role !== 'admin' || st.state === 'signed-out') {
      mount(root, h('div', { class: 'page-head' }, h('h1', null, 'Accounts')), h('section', { class: 'card' }, h('p', null, 'Only available when this manager is signed in with an admin account.')));
      return;
    }
    const o = await api.get('/api/backend/admin/overview');
    const devicesOf = (uid) => o.devices.filter((d) => d.userId === uid);
    const confirmDo = (text, fn, ok) => { if (confirm(text)) guard(async () => { await fn(); await render(); }, ok); };
    mount(root,
      h('div', { class: 'page-head' }, h('h1', null, 'Accounts'), h('div', { class: 'toolbar' }, h('span', { class: 'muted mono' }, st.url), h('button', { class: 'primary', onclick: () => newUserDialog(render) }, 'New account'))),
      h('section', { class: 'card' }, h('h2', null, 'Accounts'),
        h('table', null,
          h('thead', null, h('tr', null, ['Account', 'Role', 'Signed in on', 'Last sign-in', ''].map((t) => h('th', null, t)))),
          h('tbody', null, o.users.map((u) => h('tr', { class: u.disabled ? 'muted' : '' },
            h('td', null, h('strong', null, u.username), u.username === st.username ? h('span', { class: 'tag' }, 'you') : null, u.disabled ? h('span', { class: 'badge skipped' }, 'disabled') : null),
            h('td', null, u.role),
            h('td', null, `${devicesOf(u.id).filter((d) => d.kind === 'manager').length} manager · ${devicesOf(u.id).filter((d) => d.kind === 'agent').length} agent(s)`),
            h('td', { class: 'muted' }, u.lastLoginAt ? fmtTime(u.lastLoginAt) : '–'),
            h('td', null, h('div', { class: 'toolbar' },
              h('button', { class: 'small', onclick: () => passwordDialog(u, render) }, 'Password'),
              h('button', { class: 'small', onclick: () => guard(async () => { await api.patch(`/api/backend/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' }); await render(); }, 'Role changed') }, u.role === 'admin' ? 'Make user' : 'Make admin'),
              h('button', { class: 'small', onclick: () => confirmDo(u.disabled ? `Enable ${u.username}?` : `Disable ${u.username}? All their managers and agents are disconnected.`, () => api.patch(`/api/backend/admin/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Enabled' : 'Disabled') }, u.disabled ? 'Enable' : 'Disable'),
              u.username !== st.username ? h('button', { class: 'small danger', onclick: () => confirmDo(`Delete account ${u.username} permanently?`, () => api.del(`/api/backend/admin/users/${u.id}`), 'Account deleted') }, 'Delete') : null))))))),
      h('section', { class: 'card' }, h('h2', null, 'Signed-in managers and agents'),
        o.devices.length ? h('table', null,
          h('thead', null, h('tr', null, ['Device', 'Account', 'Type', 'State', 'Last address', 'Last seen', ''].map((t) => h('th', null, t)))),
          h('tbody', null, o.devices.map((d) => h('tr', null,
            h('td', null, h('strong', null, d.name), d.self ? h('span', { class: 'tag' }, 'this manager') : null, h('div', { class: 'muted' }, [d.info?.hostname, d.info?.os].filter(Boolean).join(' · '))),
            h('td', null, d.username),
            h('td', null, d.kind),
            h('td', null, d.online ? h('span', { class: 'badge ok' }, 'online') : h('span', { class: 'badge skipped' }, 'offline')),
            h('td', { class: 'mono' }, d.lastIp ?? '–'),
            h('td', { class: 'muted' }, relTime(d.lastSeenAt)),
            h('td', null, d.self ? null : h('button', { class: 'small danger', onclick: () => confirmDo(`Revoke "${d.name}" (${d.username})? It is disconnected and must sign in again.`, () => api.del(`/api/backend/admin/devices/${d.id}`), 'Access revoked') }, 'Revoke'))))))
          : h('p', { class: 'muted' }, 'No devices signed in.')),
      h('section', { class: 'card' }, h('h2', null, 'Backend activity'),
        h('table', null, h('tbody', null, o.audit.slice(0, 60).map((e) => h('tr', null,
          h('td', { class: 'muted mono' }, fmtTime(e.ts)), h('td', null, e.actor ?? ''), h('td', null, e.action), h('td', { class: 'muted' }, e.detail), h('td', { class: 'muted mono' }, e.ip ?? '')))))));
  };
  await render();
  return { onEvent: (ev) => { if (ev.type === 'agents.changed') { clearTimeout(accountsView.t); accountsView.t = setTimeout(render, 1500); } } };
}
