import { api } from '../api.js';
import { codeBox, fmtTime, guard, h, modal, clear } from '../ui.js';

/**
 * Message viewer. HTML mails are rendered inside a fully sandboxed iframe
 * (no scripts, no same-origin, no popups); remote images are blocked by CSP.
 */
export async function openMessage({ identityId, mailboxId, messageId, onChange }) {
  const url = identityId ? `/api/identities/${identityId}/mail/messages/${messageId}` : `/api/mailboxes/${mailboxId}/messages/${messageId}`;
  const m = await guard(() => api.get(url));
  if (!m) return;
  onChange?.();
  const bodyWrap = h('div');
  let mode = m.html ? 'html' : 'text';
  const renderBody = () => {
    clear(bodyWrap);
    if (mode === 'html' && m.html) {
      const frame = h('iframe', { class: 'mail-frame', sandbox: '', referrerpolicy: 'no-referrer' });
      frame.srcdoc = m.html;
      bodyWrap.appendChild(frame);
    } else {
      bodyWrap.appendChild(h('div', { class: 'mail-text' }, m.text || '(no text part)'));
    }
  };
  renderBody();

  const content = h(
    'div',
    null,
    h(
      'div',
      { class: 'kv' },
      h('div', null, 'From'), h('div', null, m.fromName ? `${m.fromName} <${m.from}>` : m.from),
      h('div', null, 'To'), h('div', null, m.to.join(', ')),
      h('div', null, 'Date'), h('div', null, fmtTime(m.date)),
      h('div', null, 'Identity'), h('div', null, m.identityLabel ?? 'unassigned'),
      h('div', null, 'Detected'), h('div', null, m.provider ? `${m.provider} · ${m.category}` : 'no rule matched'),
    ),
    m.codes.length
      ? h('div', { class: 'infobox' }, h('strong', null, 'Security / verification code'), h('div', { class: 'toolbar', style: { marginTop: '6px' } }, m.codes.map((c) => codeBox(c))))
      : null,
    h(
      'div',
      { class: 'toolbar', style: { margin: '10px 0' } },
      m.html ? h('button', { class: 'small', onclick: () => { mode = mode === 'html' ? 'text' : 'html'; renderBody(); } }, 'Toggle HTML / Text') : null,
      identityId
        ? h('button', { class: 'small', onclick: () => guard(() => api.post(`/api/identities/${identityId}/mail/messages/${messageId}/seen`, { seen: false }), 'Marked unread').then(onChange) }, 'Mark unread')
        : null,
      h('span', { class: 'muted' }, 'Remote images are blocked.'),
    ),
    bodyWrap,
    m.links.length
      ? h('div', null, h('h3', null, `Links (${m.links.length})`), h('ul', { class: 'links' }, m.links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.text !== l.url ? `${l.text} – ${l.url}` : l.url)))))
      : null,
    m.attachments.length
      ? h(
          'div',
          null,
          h('h3', null, `Attachments (${m.attachments.length})`),
          h(
            'ul',
            null,
            m.attachments.map((a) =>
              h(
                'li',
                null,
                identityId
                  ? h('a', { href: api.downloadUrl(`/api/identities/${identityId}/mail/messages/${messageId}/attachments/${a.index}`) }, a.filename)
                  : a.filename,
                h('span', { class: 'muted' }, ` · ${a.contentType} · ${Math.ceil(a.size / 1024)} KB`),
              ),
            ),
          ),
        )
      : null,
  );
  modal(m.subject || '(no subject)', content);
}
