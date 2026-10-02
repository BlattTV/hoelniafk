import { api } from '../api.js';
import { badge, clear, contextMenu, fmtTime, guard, h, identityName, pad2, mount, whenIdle, whenModalClosed } from '../ui.js';
import { discordTile, microsoftTile } from './accounts.js';
import {
  discordSection,
  focusSection,
  healthSection,
  loadMeta,
  mailSection,
  minecraftSection,
  networkSection,
  rewardsSection,
  sessionsSection,
  updateStats,
  settingsSection,
} from './sections.js';

export async function identityView(root, [idStr, section]) {
  const id = Number(idStr);
  const ctx = { id, data: null, meta: await loadMeta(), reload: null, chatListener: null };
  // Tabs instead of one long page; deep links (/identity/1/network …) open the tab that holds the section
  const TAB_OF = { sessions: 'overview', settings: 'settings', network: 'settings', health: 'details', minecraft: 'details', discord: 'details', mail: 'details', rewards: 'details', audit: 'details' };
  let tab = TAB_OF[section] ?? 'overview';

  const render = async () => {
    const [data, audit] = await Promise.all([api.get(`/api/identities/${id}`), api.get(`/api/audit?identityId=${id}&limit=15`)]);
    ctx.data = data;
    const scroll = window.scrollY;
    const it = data.identity;
    mount(root, 
      h('div', { class: 'page-head' },
        h('div', null,
          h('div', { class: 'muted' }, h('a', { href: '#/' }, '← Identities')),
          h('h1', null, `Identity #${pad2(it.number)} `, h('span', { class: 'muted' }, identityName(it)), ' ', badge(data.health.level)),
          it.settings.ui.tags.length ? h('div', null, it.settings.ui.tags.map((t) => h('span', { class: 'tag' }, t))) : null),
        h('div', { class: 'toolbar' },
          h('button', { class: 'primary', onclick: () => guard(async () => { await api.post('/api/bulk', { action: 'startSessions', identityIds: [id] }); await ctx.reload(); }, 'Sessions starting') }, 'Go online'),
          h('button', { onclick: () => guard(async () => { await api.post('/api/bulk', { action: 'stopSessions', identityIds: [id] }); await ctx.reload(); }, 'Sessions stopping') }, 'Go offline'),
          h('button', { title: 'More actions', onclick: (e) => contextMenu(e, [
            ['Clone (without secrets)', () => guard(async () => {
              const label = prompt('Label of the clone (credentials are NOT copied):', '');
              if (label === null) return;
              const c = await api.post(`/api/identities/${id}/clone`, { label });
              location.hash = `#/new/${c.id}/1`;
            })],
            ['Save as template', () => guard(async () => {
              const name = prompt('Template name:', `${it.label} template`);
              if (name) await api.post(`/api/identities/${id}/save-template`, { name });
            }, 'Template saved')],
            null,
            ['Delete', () => confirm(`Delete ${it.label}? All of its secrets are removed from the vault.`) && guard(async () => { await api.del(`/api/identities/${id}`); location.hash = '#/'; }, 'Identity deleted'), 'danger'],
          ]) }, 'More'),
        ),
      ),
      h('div', { class: 'tabs', role: 'tablist' },
        [['overview', 'Overview', 'Accounts and servers – start, stop, where each server runs'], ['settings', 'Settings', 'Default agent, game client, AFK, network'], ['details', 'Status & history', 'Health, Minecraft, Discord link, rewards, audit']].map(([k, label, tip]) =>
          h('button', { class: `tab ${tab === k ? 'active' : ''}`, role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', title: tip, onclick: () => { tab = k; void render(); } }, label))),
      tab === 'overview'
        ? [
            h('div', { class: 'tiles' },
              microsoftTile(id, data, ctx.reload),
              discordTile(id, data.discord, data.mail?.address ?? data.microsoft?.email ?? null, ctx.reload)),
            sessionsSection(ctx),
          ]
        : tab === 'settings'
          ? h('div', { class: 'grid-2' }, h('div', null, settingsSection(ctx)), h('div', null, networkSection(ctx)))
          : h('div', { class: 'grid-2' },
              h('div', null, healthSection(ctx), minecraftSection(ctx), discordSection(ctx)),
              h('div', null, data.mail ? mailSection(ctx) : null, rewardsSection(ctx),
                h('section', { class: 'card', id: 'sec-audit' }, h('h2', null, 'Audit (this identity)'),
                  h('table', null, h('tbody', null, audit.map((e) => h('tr', null, h('td', { class: 'muted mono' }, fmtTime(e.ts)), h('td', null, e.action), h('td', { class: 'muted' }, e.detail))))),
                  h('p', null, h('a', { href: '#/audit' }, 'Full audit log →'))))),
    );
    window.scrollTo(0, scroll);
  };
  ctx.reload = render;
  await render();
  if (section) setTimeout(() => focusSection(section), 50);

  let t;
  return {
    onEvent(ev) {
      if (ctx.chatListener) ctx.chatListener(ev);
      if (ev.identityId !== id || ev.type === 'session.chat' || ev.type === 'audit') return;
      if (updateStats(root, ev)) return; // numbers only – no full re-render every 5 s
      clearTimeout(t);
      t = setTimeout(() => whenModalClosed(() => whenIdle(root, render)), 500); // never under an open dialog or unsaved edits
    },
  };
}
