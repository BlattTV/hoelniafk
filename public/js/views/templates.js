import { api } from '../api.js';
import { clear, field, formData, guard, h, modal, select, mount } from '../ui.js';

export async function templatesView(root) {
  const render = async () => {
    const [templates, servers, rules] = await Promise.all([api.get('/api/templates'), api.get('/api/servers'), api.get('/api/rules')]);
    mount(root, 
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Identity Templates'), h('div', { class: 'sub' }, 'Templates never contain credentials, accounts or concrete IP addresses.')),
        h('button', { class: 'primary', onclick: () => edit(null, servers, rules, render) }, '＋ New template')),
      templates.length
        ? templates.map((t) => h('section', { class: 'card' },
            h('div', { class: 'page-head', style: { marginBottom: '6px' } }, h('h1', null, t.name),
              h('div', { class: 'toolbar' },
                h('button', { class: 'small primary', onclick: () => guard(async () => { const r = await api.post('/api/identities', { templateId: t.id }); location.hash = `#/wizard/${r.identity.id}/0`; }) }, 'Create identity'),
                h('button', { class: 'small', onclick: () => edit(t, servers, rules, render) }, 'Edit'),
                h('button', { class: 'small danger', onclick: () => confirm('Delete template?') && guard(async () => { await api.del(`/api/templates/${t.id}`); await render(); }) }, '✕'))),
            h('pre', { class: 'mono muted', style: { margin: 0 } }, describe(t.config))))
        : h('div', { class: 'card empty' }, 'No templates yet.'),
    );
  };
  await render();
}

function describe(c) {
  const s = c.settings ?? {};
  return [
    `Network:          ${c.network?.mode ?? 'PER_ACCOUNT'}${c.network?.kind ? ` (${c.network.kind})` : ''}`,
    `Servers:          ${(c.servers ?? []).join(', ') || '–'}`,
    `AutoReconnect:    ${s.autoReconnect ?? true}`,
    `Mail:             ${s.mailEnabled === false ? 'disabled' : 'enabled'}`,
    `Discord Linking:  ${s.discordLinking ?? 'optional'}`,
    `AFK:              ${s.afk ? `${s.afk.enabled ? s.afk.action : 'off'} / ${s.afk.intervalSec}s` : 'default'}`,
    `Parsers:          ${(s.parsers ?? []).join(', ') || 'default'}`,
  ].join('\n');
}

function edit(t, servers, rules, render) {
  const c = t?.config ?? { settings: {}, servers: [], network: { mode: 'PER_ACCOUNT' } };
  const s = c.settings ?? {};
  const f = h('div', null,
    h('div', { class: 'form-grid' },
      field('Name', h('input', { name: 'name', value: t?.name ?? 'Default AFK Identity' })),
      field('Network mode', select('mode', ['PER_ACCOUNT', 'SHARED', 'DIRECT'], c.network?.mode ?? 'PER_ACCOUNT')),
      field('Suggested network kind', select('kind', [['', '–'], 'BIND', 'SOCKS5', 'HTTP', 'DIRECT'], c.network?.kind ?? '')),
      field('Discord linking', select('discordLinking', ['required', 'optional', 'disabled'], s.discordLinking ?? 'required')),
      field('AFK action', select('afkAction', ['none', 'look', 'swing', 'jump'], s.afk?.action ?? 'look')),
      field('AFK interval (s)', h('input', { type: 'number', name: 'afkIntervalSec', value: s.afk?.intervalSec ?? 45 }))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'autoReconnect', checked: s.autoReconnect ?? true }), 'AutoReconnect'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mailEnabled', checked: s.mailEnabled ?? true }), 'Mail enabled'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'afkEnabled', checked: s.afk?.enabled ?? true }), 'Anti-AFK')),
    h('h3', null, 'Servers'),
    h('div', { class: 'toolbar' }, servers.map((sv) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { server: sv.name }, checked: (c.servers ?? []).includes(sv.name) }), sv.name))),
    h('h3', null, 'Chat parsers'),
    h('div', { class: 'toolbar' }, rules.chatRules.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', dataset: { parser: r.id }, checked: (s.parsers ?? rules.chatRules.map((x) => x.id)).includes(r.id) }), r.id))),
  );
  const m = modal(t ? `Edit ${t.name}` : 'New template', h('div', null, f, h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: () => guard(async () => {
    const b = formData(f);
    const config = {
      settings: {
        autoReconnect: b.autoReconnect,
        mailEnabled: b.mailEnabled,
        discordLinking: b.discordLinking,
        afk: { enabled: b.afkEnabled, action: b.afkAction, intervalSec: b.afkIntervalSec },
        parsers: [...f.querySelectorAll('[data-parser]')].filter((x) => x.checked).map((x) => x.dataset.parser),
      },
      servers: [...f.querySelectorAll('[data-server]')].filter((x) => x.checked).map((x) => x.dataset.server),
      network: { mode: b.mode, ...(b.kind ? { kind: b.kind } : {}) },
    };
    if (t) await api.put(`/api/templates/${t.id}`, { name: b.name, config });
    else await api.post('/api/templates', { name: b.name, config });
    m.close();
    await render();
  }, 'Template saved') }, 'Save'))));
}
