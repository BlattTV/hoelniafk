import { api } from '../api.js';
import { badge, clear, fmtTime, guard, h, identityName, pad2, mount, whenModalClosed } from '../ui.js';
import {
  discordSection,
  focusSection,
  healthSection,
  loadMeta,
  mailSection,
  milestoneStrip,
  minecraftSection,
  networkSection,
  rewardsSection,
  sessionsSection,
  settingsSection,
} from './sections.js';

export async function identityView(root, [idStr, section]) {
  const id = Number(idStr);
  const ctx = { id, data: null, meta: await loadMeta(), reload: null, chatListener: null };

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
          h('button', { onclick: () => (location.hash = `#/wizard/${id}`) }, 'Setup wizard'),
          h('button', { onclick: () => guard(async () => { await api.post('/api/bulk', { action: 'startSessions', identityIds: [id] }); await ctx.reload(); }, 'Sessions starting') }, 'Start all sessions'),
          h('button', { onclick: () => guard(async () => {
            const label = prompt('Label of the clone (credentials are NOT copied):', '');
            if (label === null) return;
            const c = await api.post(`/api/identities/${id}/clone`, { label });
            location.hash = `#/wizard/${c.id}`;
          }) }, 'Clone (without secrets)'),
          h('button', { onclick: () => guard(async () => {
            const name = prompt('Template name:', `${it.label} template`);
            if (name) await api.post(`/api/identities/${id}/save-template`, { name });
          }, 'Template saved') }, 'Save as template'),
          h('button', { class: 'danger', onclick: () => confirm(`Delete ${it.label}? All of its secrets are removed from the vault.`) && guard(async () => { await api.del(`/api/identities/${id}`); location.hash = '#/'; }, 'Identity deleted') }, 'Delete'),
        ),
      ),
      milestoneStrip(data.health),
      h('div', { class: 'grid-2' },
        h('div', null, minecraftSection(ctx), discordSection(ctx), networkSection(ctx), rewardsSection(ctx)),
        h('div', null, healthSection(ctx), mailSection(ctx), sessionsSection(ctx), settingsSection(ctx),
          h('section', { class: 'card', id: 'sec-audit' }, h('h2', null, 'Audit (this identity)'),
            h('table', null, h('tbody', null, audit.map((e) => h('tr', null, h('td', { class: 'muted mono' }, fmtTime(e.ts)), h('td', null, e.action), h('td', { class: 'muted' }, e.detail))))),
            h('p', null, h('a', { href: '#/audit' }, 'Full audit log →')))),
      ),
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
      clearTimeout(t);
      t = setTimeout(() => whenModalClosed(render), 500); // never re-render under an open dialog
    },
  };
}
