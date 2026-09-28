import { api, qs } from '../api.js';
import { clear, codeBox, fmtTime, formData, guard, h, identityName, pad2, select, mount } from '../ui.js';
import { openMessage } from './mailviewer.js';

/** ALL MAIL (global inbox) and the Verification / Account Mail view. */
export async function inboxView(root, { verification }) {
  const [dash, rules] = await Promise.all([api.get('/api/dashboard'), api.get('/api/rules')]);
  const providers = [...new Set(rules.mailRules.map((r) => r.provider))];
  const filters = h(
    'div',
    { class: 'toolbar' },
    select('identityId', [['', 'all identities'], ...dash.rows.map((r) => [r.id, `#${pad2(r.number)} ${identityName(r)}`])], ''),
    select('provider', [['', 'all providers'], ...providers.map((p) => [p, p])], ''),
    select('category', verification
      ? [['verification-any', 'verification + security + account'], ['verification', 'verification'], ['security', 'security'], ['account', 'account']]
      : [['', 'all categories'], ['verification', 'verification'], ['security', 'security'], ['account', 'account']], verification ? 'verification-any' : ''),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'unread' }), 'unread only'),
    h('input', { name: 'q', placeholder: 'Search subject / sender' }),
    h('button', { onclick: () => guard(async () => {
      const ids = dash.rows.filter((r) => r.mail.address).map((r) => r.id);
      if (ids.length) await api.post('/api/bulk', { action: 'checkMail', identityIds: ids });
      await load();
    }, 'Mail checked') }, 'Check all mail'),
  );
  const list = h('div', { class: 'card', style: { padding: 0 } });
  mount(root, 
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, verification ? 'Verification / Account Mail' : 'All mail'), h('div', { class: 'sub' }, verification ? 'Mails recognised by the rules in rules.yaml – codes can be revealed and copied.' : 'Mail of all identities')), filters),
    list,
  );

  const revealCodes = async (m, cell) => {
    const d = await guard(() => api.get(`/api/identities/${m.identityId}/mail/messages/${m.id}?markSeen=0`));
    if (!d) return;
    mount(cell, ...(d.codes.length ? d.codes.map((c) => codeBox(c)) : [h('span', { class: 'muted' }, 'no code found')]));
  };

  const load = async () => {
    const msgs = await api.get(`/api/inbox${qs(formData(filters))}`);
    clear(list).appendChild(
      msgs.length
        ? h('table', null,
            h('thead', null, h('tr', null, ['Time', 'Identity', 'Provider', 'Subject', verification ? 'Code' : 'From'].map((t) => h('th', null, t)))),
            h('tbody', null, msgs.map((m) => {
              const codeCell = h('td', null, h('button', { class: 'small', onclick: (e) => { e.stopPropagation(); revealCodes(m, codeCell); } }, 'Show code'));
              return h('tr', { class: 'clickable', onclick: () => openMessage({ identityId: m.identityId, messageId: m.id, onChange: load }) },
                h('td', { class: 'mono muted' }, fmtTime(m.date)),
                h('td', null, `Identity${pad2(m.identityNumber ?? 0)}`, m.identityLabel && m.identityLabel !== `Identity${pad2(m.identityNumber ?? 0)}` ? h('div', { class: 'muted' }, m.identityLabel) : null),
                h('td', null, m.provider ? h('span', { class: 'tag' }, m.provider) : h('span', { class: 'muted' }, '–'), m.category ? h('div', { class: 'muted' }, m.category) : null),
                h('td', { style: { fontWeight: m.seen ? 'normal' : '600' } }, m.subject || '(no subject)'),
                verification ? codeCell : h('td', { class: 'muted' }, m.fromName || m.from));
            })))
        : h('div', { class: 'empty' }, 'No messages match.'),
    );
  };
  let t;
  filters.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  filters.addEventListener('change', load);
  await load();
  return {
    onEvent(ev) {
      if (ev.type === 'mail.updated') { clearTimeout(t); t = setTimeout(load, 500); }
    },
  };
}
