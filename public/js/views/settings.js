import { api } from '../api.js';
import { clear, copy, field, guard, h, mount } from '../ui.js';

export async function settingsView(root) {
  const render = async () => {
    const [settings, status, vault, rules] = await Promise.all([api.get('/api/settings'), api.get('/api/status'), api.get('/api/vault'), api.get('/api/rules')]);
    const oauthCard = (p, title, hint) => {
      const s = settings.oauth[p];
      const id = h('input', { value: s.clientId, placeholder: 'client id', style: { width: '100%' } });
      const secret = h('input', { type: 'password', placeholder: s.hasClientSecret ? 'stored ✓ (leave empty to keep)' : 'optional for public clients', autocomplete: 'new-password', style: { width: '100%' } });
      const tenant = p === 'microsoft' ? h('input', { value: s.tenant, style: { width: '100%' } }) : null;
      return h('div', { class: 'card' }, h('h2', null, title), h('p', { class: 'muted' }, hint),
        h('div', { class: 'form-grid' }, field('Client ID', id), field('Client secret', secret), tenant ? field('Tenant', tenant) : null),
        h('div', { class: 'form-actions' },
          h('button', { class: 'primary', onclick: () => guard(async () => { await api.put(`/api/settings/oauth/${p}`, { clientId: id.value, clientSecret: secret.value || undefined, tenant: tenant?.value }); await render(); }, 'Saved') }, 'Save'),
          s.hasClientSecret ? h('button', { class: 'danger', onclick: () => guard(async () => { await api.put(`/api/settings/oauth/${p}`, { clientSecret: null }); await render(); }, 'Secret removed') }, 'Remove secret') : null));
    };
    mount(root, 
      h('div', { class: 'page-head' }, h('h1', null, 'Settings & Credential Vault')),
      h('div', { class: 'grid-2' },
        h('div', null,
          h('section', { class: 'card' }, h('h2', null, 'Credential Vault'),
            h('div', { class: 'kv' }, h('div', null, 'Backend'), h('div', { class: 'mono' }, vault.backend), h('div', null, 'Stored secrets'), h('div', null, String(vault.refs.length))),
            h('p', { class: 'muted' }, 'Secrets are AES-256-GCM encrypted; the master key is protected by Windows DPAPI or the Windows Credential Manager. SQLite only stores references. Values are never shown in the UI.'),
            h('ul', { class: 'mono', style: { fontSize: '12px' } }, vault.refs.map((r) => h('li', null, r)))),
          h('section', { class: 'card' }, h('h2', null, 'OAuth redirect URI'),
            h('p', null, 'Register this redirect URI in every OAuth app (Discord, Microsoft, Google):'),
            h('div', { class: 'toolbar' }, h('code', null, settings.redirectUri), h('button', { class: 'small', onclick: () => copy(settings.redirectUri, 'URI copied') }, 'Copy'))),
          h('section', { class: 'card' }, h('h2', null, 'Recognition rules'),
            h('p', { class: 'muted' }, `config/rules.yaml – ${rules.mailRules.length} mail rules, ${rules.chatRules.length} chat rule-sets.`),
            h('table', null, h('tbody', null,
              rules.mailRules.map((r) => h('tr', null, h('td', null, h('span', { class: 'tag' }, 'mail'), r.id), h('td', null, r.provider), h('td', null, r.category), h('td', { class: 'mono muted' }, [...r.senders, ...r.subjectContains.map((s) => `"${s}"`)].join(', ')))),
              rules.chatRules.map((r) => h('tr', null, h('td', null, h('span', { class: 'tag' }, 'chat'), r.id), h('td', null, r.type), h('td', { colspan: 2, class: 'mono muted' }, (r.type === 'linking' ? r.linkCode : r.set).join(' | ')))))),
            h('div', { class: 'form-actions' }, h('button', { onclick: () => guard(async () => { await api.post('/api/rules/reload'); await render(); }, 'Rules reloaded') }, 'Reload rules'))),
          h('section', { class: 'card' }, h('h2', null, 'Automation / Monitoring'),
            h('div', { class: 'kv' },
              h('div', null, 'Mail check'), h('div', null, settings.automation.mailCheckMinutes ? `every ${settings.automation.mailCheckMinutes} min` : 'off'),
              h('div', null, 'Network check'), h('div', null, settings.automation.networkCheckMinutes ? `every ${settings.automation.networkCheckMinutes} min` : 'off'),
              h('div', null, 'Discord verify'), h('div', null, settings.automation.discordVerifyHours ? `every ${settings.automation.discordVerifyHours} h` : 'off'),
              h('div', null, 'Auto-start sessions'), h('div', null, settings.automation.autoStartSessions ? 'yes' : 'no')),
            h('p', { class: 'muted' }, 'Configured in config/app.yaml.'))),
        h('div', null,
          oauthCard('discord', 'Discord OAuth2', 'Discord Developer Portal → your application → OAuth2. Used only to connect existing accounts (scope "identify").'),
          oauthCard('microsoft', 'Microsoft OAuth2 (mail)', 'Azure portal → App registrations → public client ("Mobile and desktop") with IMAP.AccessAsUser.All / SMTP.Send.'),
          oauthCard('google', 'Google OAuth2 (mail)', 'Google Cloud console → OAuth client of type "Desktop app" with the Gmail scope.'),
          h('section', { class: 'card' }, h('h2', null, 'About'), h('p', { class: 'muted' }, `${status.name} ${status.version}`)))),
    );
  };
  await render();
}
