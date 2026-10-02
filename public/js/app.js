import { api, recoverAfterRestart, subscribe } from './api.js';
import { clear, h, toast } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { identityView } from './views/identity.js';
import { wizardView } from './views/wizard.js';
import { inboxView } from './views/inbox.js';
import { mailboxesView } from './views/mailboxes.js';
import { serversView } from './views/servers.js';
import { sessionsView } from './views/sessions.js';
import { matrixView } from './views/matrix.js';
import { chatView } from './views/chat.js';
import { monitoringView } from './views/monitoring.js';
import { logsView } from './views/logs.js';
import { setupView } from './views/setup.js';
import { templatesView } from './views/templates.js';
import { auditView } from './views/audit.js';
import { settingsView } from './views/settings.js';
import { schedulesView } from './views/schedules.js';
import { accountsView, agentsView, takeOver } from './views/remote.js';
import { proxiesView } from './views/proxies.js';
import { quickView } from './views/quick.js';
import { discordView } from './views/discord.js';
import { outlookView } from './views/outlook.js';
import { macrosView } from './views/macros.js';
import { loginsView } from './views/logins.js';
import { openPalette, toggleTheme } from './palette.js';
import { handleEvent, primeStates } from './notify.js';
import { syncLanguage, t, translateStatic } from './i18n.js';

translateStatic(document.querySelector('.sidebar'));
api.get('/api/settings/ui').then((s) => syncLanguage(s.language)).catch(() => undefined);

const routes = [
  [/^\/?$/, 'dashboard', dashboardView],
  [/^\/identity\/(\d+)(?:\/(\w+))?$/, 'dashboard', identityView],
  [/^\/wizard(?:\/(\d+))?(?:\/(\d+))?$/, 'wizard', wizardView],
  [/^\/new(?:\/(\d+))?(?:\/(\d+))?$/, 'new', quickView],
  [/^\/discord$/, 'discord', discordView],
  [/^\/logins$/, 'logins', loginsView],
  [/^\/mail$/, 'mail', outlookView],
  [/^\/macros$/, 'macros', macrosView],
  [/^\/inbox$/, 'inbox', (root) => inboxView(root, { verification: false })],
  [/^\/verification$/, 'verification', (root) => inboxView(root, { verification: true })],
  [/^\/mailboxes$/, 'mailboxes', mailboxesView],
  [/^\/servers$/, 'servers', serversView],
  [/^\/sessions$/, 'sessions', sessionsView],
  [/^\/matrix$/, 'matrix', matrixView],
  [/^\/chat$/, 'chat', chatView],
  [/^\/monitoring$/, 'monitoring', monitoringView],
  [/^\/logs$/, 'logs', logsView],
  [/^\/setup$/, 'setup', setupView],
  [/^\/templates$/, 'templates', templatesView],
  [/^\/audit$/, 'audit', auditView],
  [/^\/settings$/, 'settings', settingsView],
  [/^\/schedules$/, 'schedules', schedulesView],
  [/^\/agents$/, 'agents', agentsView],
  [/^\/proxies$/, 'proxies', proxiesView],
  [/^\/accounts$/, 'accounts', accountsView],
];

let current = null; // { onEvent }
let renderSeq = 0;

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  const root = document.getElementById('view');
  const seq = ++renderSeq;
  for (const [re, nav, view] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    const container = h('div');
    try {
      const handle = await view(container, m.slice(1));
      if (seq !== renderSeq) return; // a newer navigation won
      clear(root).appendChild(container);
      current = handle || null;
    } catch (e) {
      if (seq !== renderSeq) return;
      clear(root).appendChild(h('div', { class: 'card' }, h('h1', null, 'Error'), h('p', null, e.message)));
      current = null;
    }
    return;
  }
  clear(root).appendChild(h('div', { class: 'empty' }, 'Not found'));
}

window.addEventListener('hashchange', render);
render();

document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'p')) {
    e.preventDefault();
    openPalette();
  }
});

const showUpdate = (st) => {
  const el = document.getElementById('nav-update');
  if (!el || !st) return;
  el.hidden = !st.available;
  if (st.latest) el.textContent = t(`Update ${st.latest.version} ready`);
};
api.get('/api/updates').then(showUpdate).catch(() => undefined);
// The account administration is only shown to admins signed in to the backend.
const showBackend = (st) => {
  const el = document.getElementById('nav-accounts');
  if (el && st) el.hidden = !(st.role === 'admin' && st.state !== 'signed-out');
  // another PC of the account runs the sessions: say so everywhere, with "Take over here"
  const banner = document.getElementById('standby-banner');
  if (!banner || !st) return;
  banner.hidden = st.pcRole !== 'standby';
  if (banner.hidden) return;
  banner.replaceChildren(
    h('span', null, t('Standby – the sessions run on'), ' ', h('strong', null, st.activePc ?? t('another PC')), '. ', t('You can change everything here; it is synchronized.')),
    h('button', { class: 'small primary', onclick: () => takeOver() }, t('Take over here')),
  );
};
api.get('/api/backend').then(showBackend).catch(() => undefined);
api.get('/api/sessions').then(primeStates).catch(() => undefined);

subscribe(
  (ev) => {
    if (ev.type === 'auth.devicecode') {
      toast(`Microsoft login for identity ${ev.identityId}: code ${ev.data.userCode} at ${ev.data.verificationUri}`, 'info', 20000);
    }
    handleEvent(ev);
    if (ev.type === 'updates.status') {
      showUpdate(ev.data);
      // automatic install: the suite restarts by itself – reload once it is back
      if (ev.data?.state === 'restarting') void recoverAfterRestart({ expectRestart: true, message: 'Installing the update – the suite restarts…' });
    }
    if (ev.type === 'agents.changed') showBackend(ev.data);
    if (current && current.onEvent) current.onEvent(ev);
  },
  (live) => {
    const el = document.getElementById('conn-state');
    el.textContent = t(live ? 'live' : 'reconnecting…');
    el.classList.toggle('live', live);
  },
);

/** Debounce helper for views that re-render on events. */
export function debounce(fn, ms = 400) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
