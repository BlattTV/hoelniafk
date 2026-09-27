import { api } from '../api.js';
import { h, mount, statusIcon } from '../ui.js';

/** Configuration validation: what is set up, what is missing and where to fix it. */
export async function setupView(root) {
  const list = h('div', { class: 'card' });
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Setup Check'), h('div', { class: 'sub' }, 'Validation of the configuration. Items marked ⚠ need your input (credentials, OAuth apps, servers).'))),
    list,
    h('div', { class: 'card' }, h('h2', null, 'First steps'),
      h('ol', null,
        h('li', null, 'Settings & Vault: export a vault recovery kit and store it offline.'),
        h('li', null, 'Settings & Vault: enter the Discord OAuth client (and Microsoft/Google if you use OAuth mailboxes).'),
        h('li', null, 'Server Profiles: add your Minecraft server(s).'),
        h('li', null, 'Mailboxes & Aliases: add the mailbox(es).'),
        h('li', null, '＋ New Identity: run the wizard for ONE identity until everything is green, then scale with templates/clone.'))));
  const d = await api.get('/api/setup/checks');
  mount(list, h('h2', null, d.ok ? 'No blocking problems' : 'Blocking problems found'),
    h('ul', { class: 'health-list' }, d.checks.map((c) =>
      h('li', { onclick: () => c.action && (location.hash = c.action), title: c.action ? 'Click to fix' : '' },
        h('span', null, c.label), h('span', { class: `s-${c.status}` }, statusIcon(c.status)), h('span', { class: 'muted' }, c.detail)))));
  return { onEvent() {} };
}
