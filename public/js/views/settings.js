import { api } from '../api.js';
import { guard, h, mount } from '../ui.js';
import { updatesCard } from './updates.js';
import { backendCard, syncCard } from './remote.js';
import { notificationsEnabled, setNotifications } from '../notify.js';
import { toggleTheme } from '../palette.js';
import { lang, LANGUAGES, setLanguage } from '../i18n.js';

export async function settingsView(root) {
  const render = async () => {
    const [settings, status, vault, rules, updates, backend] = await Promise.all([api.get('/api/settings'), api.get('/api/status'), api.get('/api/vault'), api.get('/api/rules'), api.get('/api/updates'), api.get('/api/backend')]);
    mount(root, 
      h('div', { class: 'page-head' }, h('h1', null, 'Settings & Credential Vault')),
      backendCard(backend, render),
      syncCard(backend, render),
      updatesCard(updates, render, backend),
      h('section', { class: 'card' }, h('h2', null, 'This PC'),
        h('div', { class: 'toolbar' },
          h('label', { class: 'check', title: 'Session blocked or disconnected, link code received, update ready' }, h('input', { type: 'checkbox', checked: notificationsEnabled(), onchange: (e) => setNotifications(e.target.checked) }), 'Desktop notifications'),
          h('label', { class: 'check' }, 'Language', ' ',
            h('select', { id: 'ui-language', 'aria-label': 'Language', onchange: (e) => guard(async () => { await api.put('/api/settings/ui', { language: e.target.value }); setLanguage(e.target.value); }) },
              LANGUAGES.map(([v, name]) => h('option', { value: v, selected: v === lang }, name)))),
          h('button', { class: 'small', onclick: toggleTheme }, 'Switch light / dark'),
          h('span', { class: 'muted' }, 'Quick actions: ', h('kbd', null, 'Ctrl'), ' ', h('kbd', null, 'K')))),
      h('div', { class: 'grid-2' },
        h('div', null,
          h('section', { class: 'card' }, h('h2', null, 'Credential Vault'),
            h('div', { class: 'kv' }, h('div', null, 'Backend'), h('div', { class: 'mono' }, vault.backend), h('div', null, 'Stored secrets'), h('div', null, String(vault.refs.length))),
            h('p', { class: 'muted' }, 'Secrets are AES-256-GCM encrypted; the master key is protected by Windows DPAPI or the Windows Credential Manager. SQLite only stores references. Values are never shown in the UI.'),
            h('h3', null, 'Recovery kit'),
            h('p', { class: 'muted' }, 'DPAPI / Credential Manager keys are bound to this Windows user and PC. Export a passphrase-protected recovery kit and keep it offline – restore with “npm run vault -- recover --kit <file>”.'),
            (() => {
              const pw = h('input', { type: 'password', placeholder: 'passphrase (min. 12 chars)', autocomplete: 'new-password' });
              const pw2 = h('input', { type: 'password', placeholder: 'repeat passphrase', autocomplete: 'new-password' });
              return h('div', { class: 'form-actions' }, pw, pw2, h('button', { onclick: () => guard(async () => {
                if (pw.value !== pw2.value) throw new Error('Passphrases do not match');
                const kit = await api.post('/api/vault/recovery-kit', { passphrase: pw.value });
                const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' })), download: 'hoelni-vault-recovery.json' });
                document.body.appendChild(a);
                a.click();
                a.remove();
                pw.value = '';
                pw2.value = '';
              }, 'Recovery kit downloaded – store it offline') }, 'Export recovery kit'));
            })(),
            h('h3', null, 'Stored secrets (references only)'),
            h('ul', { class: 'mono', style: { fontSize: '12px' } }, vault.refs.map((r) => h('li', null, r)))),
          h('section', { class: 'card' }, h('h2', null, 'Recognition rules'),
            h('p', { class: 'muted' }, `config/rules.yaml – ${rules.mailRules.length} mail rules, ${rules.chatRules.length} chat rule-sets.`),
            h('table', null, h('tbody', null,
              rules.mailRules.map((r) => h('tr', null, h('td', null, h('span', { class: 'tag' }, 'mail'), r.id), h('td', null, r.provider), h('td', null, r.category), h('td', { class: 'mono muted wrap' }, [...r.senders, ...r.subjectContains.map((s) => `"${s}"`)].join(', ')))),
              rules.chatRules.map((r) => h('tr', null, h('td', null, h('span', { class: 'tag' }, 'chat'), r.id), h('td', null, r.type), h('td', { colspan: 2, class: 'mono muted wrap' }, (r.type === 'linking' ? r.linkCode : r.set).join(' | ')))))),
            h('div', { class: 'form-actions' }, h('button', { onclick: () => guard(async () => { await api.post('/api/rules/reload'); await render(); }, 'Rules reloaded') }, 'Reload rules'))),
          h('section', { class: 'card' }, h('h2', null, 'Automation / Monitoring'),
            h('div', { class: 'kv' },
              h('div', null, 'Mail check'), h('div', null, settings.automation.mailCheckMinutes ? `every ${settings.automation.mailCheckMinutes} min` : 'off'),
              h('div', null, 'Network check'), h('div', null, settings.automation.networkCheckMinutes ? `every ${settings.automation.networkCheckMinutes} min` : 'off'),
              h('div', null, 'Token refresh'), h('div', null, settings.automation.tokenRefreshHours ? `every ${settings.automation.tokenRefreshHours} h` : 'off'),
              h('div', null, 'Restore sessions'), h('div', null, settings.automation.restoreSessions ? 'desired-state reconciler active' : 'off')),
            h('p', { class: 'muted' }, 'Configured in config/app.yaml.'))),
        h('div', null,
          h('section', { class: 'card' }, h('h2', null, 'About'), h('p', { class: 'muted' }, `${status.name} ${status.version}`)))),
    );
  };
  await render();
}
