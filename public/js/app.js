import { subscribe } from './api.js';
import { clear, h, toast } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { identityView } from './views/identity.js';
import { wizardView } from './views/wizard.js';
import { inboxView } from './views/inbox.js';
import { mailboxesView } from './views/mailboxes.js';
import { serversView, sessionsView } from './views/servers.js';
import { templatesView } from './views/templates.js';
import { auditView } from './views/audit.js';
import { settingsView } from './views/settings.js';

const routes = [
  [/^\/?$/, 'dashboard', dashboardView],
  [/^\/identity\/(\d+)(?:\/(\w+))?$/, 'dashboard', identityView],
  [/^\/wizard(?:\/(\d+))?(?:\/(\d+))?$/, 'wizard', wizardView],
  [/^\/inbox$/, 'inbox', (root) => inboxView(root, { verification: false })],
  [/^\/verification$/, 'verification', (root) => inboxView(root, { verification: true })],
  [/^\/mailboxes$/, 'mailboxes', mailboxesView],
  [/^\/servers$/, 'servers', serversView],
  [/^\/sessions$/, 'sessions', sessionsView],
  [/^\/templates$/, 'templates', templatesView],
  [/^\/audit$/, 'audit', auditView],
  [/^\/settings$/, 'settings', settingsView],
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

subscribe(
  (ev) => {
    if (ev.type === 'auth.devicecode') {
      toast(`Microsoft login for identity ${ev.identityId}: code ${ev.data.userCode} at ${ev.data.verificationUri}`, 'info', 20000);
    }
    if (current && current.onEvent) current.onEvent(ev);
  },
  (live) => {
    const el = document.getElementById('conn-state');
    el.textContent = live ? 'live' : 'reconnecting…';
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
