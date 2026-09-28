import { api } from '../api.js';
import { clear, field, guard, h, pad2, select, statusIcon, mount, whenModalClosed } from '../ui.js';
import { discordSection, loadMeta, mailSection, minecraftSection, networkSection, sessionsSection } from './sections.js';

const STEPS = [
  ['Mail', (ctx) => mailSection(ctx, { withInbox: false })],
  ['Minecraft', minecraftSection],
  ['Discord', discordSection],
  ['Network Profile', networkSection],
  ['Server Assignments', sessionsSection],
  ['Verification', verificationStep],
];

function readiness(data) {
  const c = (k) => data.health.checks.find((x) => x.key === k);
  const ok = (k) => ['ok', 'skipped'].includes(c(k).status);
  return [
    ['Mail configured', ok('mailAccess'), 0],
    ['Minecraft authenticated', ok('minecraftAuth'), 1],
    ['Discord set up', ok('discordOAuth'), 2],
    ['Exit IP verified', ok('networkProfile') && ok('expectedIp'), 3],
    ['Hoelni Discord link', ok('discordLinked'), 2],
    ['Server assignments', data.assignments.length > 0, 4],
  ];
}

function verificationStep(ctx) {
  const items = readiness(ctx.data);
  const ready = items.every(([, ok]) => ok);
  return h(
    'section',
    { class: 'card', id: 'sec-verification' },
    h('h2', null, `Identity #${pad2(ctx.data.identity.number)}`),
    h('ul', { class: 'health-list' }, items.map(([label, ok, step]) =>
      h('li', { onclick: () => (location.hash = `#/wizard/${ctx.id}/${step}`) }, h('span', null, label), h('span', { class: `mark ${ok ? 'ok' : 'error'}`, title: ok ? 'done' : 'missing' }), h('span', { class: 'muted' }, ok ? '' : 'click to fix')))),
    h('div', { style: { margin: '16px 0' } }, h('span', { class: `ready-banner ${ready ? 'ok' : 'no'}` }, ready ? 'READY' : 'NOT READY')),
    h('h3', null, 'Detailed health'),
    h('ul', { class: 'health-list' }, ctx.data.health.checks.map((c) => h('li', null, h('span', null, c.label), h('span', { class: `s-${c.status}` }, statusIcon(c.status)), h('span', { class: 'muted' }, c.detail)))),
    h('div', { class: 'form-actions' },
      h('button', { onclick: () => guard(async () => { await api.post('/api/bulk', { action: 'verifyNetwork', identityIds: [ctx.id] }); await api.post('/api/bulk', { action: 'checkMail', identityIds: [ctx.id] }); await ctx.reload(); }, 'Re-checked') }, 'Re-run checks'),
      h('button', { onclick: () => guard(async () => { await api.post('/api/bulk', { action: 'startSessions', identityIds: [ctx.id] }); await ctx.reload(); }, 'Sessions starting') }, 'Start sessions'),
      h('button', { class: 'primary', onclick: () => (location.hash = `#/identity/${ctx.id}`) }, 'Open identity'),
    ),
  );
}

async function createStep(root, meta) {
  const form = h(
    'div',
    { class: 'form-grid' },
    field('Label', h('input', { name: 'label', placeholder: 'Identity07 (auto if empty)' })),
    field('Template', select('templateId', [['', '– none –'], ...meta.templates.map((t) => [t.id, t.name])], meta.templates.find((t) => /default/i.test(t.name))?.id ?? '')),
  );
  mount(root, 
    h('div', { class: 'page-head' }, h('h1', null, 'CREATE NEW IDENTITY')),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Step 0 – base settings. Templates pre-configure network mode, servers, auto-reconnect, mail and Discord-linking requirements.'),
      form,
      h('button', { class: 'primary', onclick: () => guard(async () => {
        const f = Object.fromEntries([...form.querySelectorAll('[name]')].map((e) => [e.name, e.value]));
        const res = await api.post('/api/identities', { label: f.label || undefined, templateId: f.templateId ? Number(f.templateId) : null });
        for (const w of res.warnings) alert(w);
        location.hash = `#/wizard/${res.identity.id}/0`;
      }) }, 'Create & continue')),
  );
}

export async function wizardView(root, [idStr, stepStr]) {
  const meta = await loadMeta();
  if (!idStr) return createStep(root, meta);
  const id = Number(idStr);
  const step = Math.min(Number(stepStr ?? 0), STEPS.length - 1);
  const ctx = { id, meta, data: null, reload: null, chatListener: null };
  const render = async () => {
    ctx.data = await api.get(`/api/identities/${id}`);
    const done = readiness(ctx.data);
    const stepDone = [done[0][1], done[1][1], done[2][1] && done[4][1], done[3][1], done[5][1], done.every(([, ok]) => ok)];
    mount(root, 
      h('div', { class: 'page-head' }, h('h1', null, `Setup · Identity #${pad2(ctx.data.identity.number)} `, h('span', { class: 'muted' }, ctx.data.identity.label))),
      h('div', { class: 'stepper' }, STEPS.map(([label], i) =>
        h('div', { class: `st ${i === step ? 'cur' : ''} ${stepDone[i] ? 'done' : ''}`, onclick: () => (location.hash = `#/wizard/${id}/${i}`) }, `${i + 1}. ${label}${stepDone[i] ? ' – done' : ''}`))),
      STEPS[step][1](ctx),
      h('div', { class: 'form-actions' },
        step > 0 ? h('button', { onclick: () => (location.hash = `#/wizard/${id}/${step - 1}`) }, '← Back') : null,
        step < STEPS.length - 1 ? h('button', { class: 'primary', onclick: () => (location.hash = `#/wizard/${id}/${step + 1}`) }, 'Next →') : null,
        h('button', { onclick: () => (location.hash = `#/identity/${id}`) }, 'Skip wizard'),
      ),
    );
  };
  ctx.reload = render;
  await render();
  let t;
  return {
    onEvent(ev) {
      if (ctx.chatListener) ctx.chatListener(ev);
      if (ev.identityId !== id || ev.type === 'session.chat' || ev.type === 'audit') return;
      clearTimeout(t);
      t = setTimeout(() => whenModalClosed(render), 500);
    },
  };
}
