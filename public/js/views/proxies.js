/** Proxy pool: import lists, test, assign one proxy per identity. Passwords are never shown. */
import { api } from '../api.js';
import { field, guard, h, mount, relTime, toast } from '../ui.js';
import { t } from '../i18n.js';

const STATUS = { OK: 'ok', ERROR: 'error', UNKNOWN: 'unknown' };

export async function proxiesView(root) {
  const render = async () => {
    const [list, dash] = await Promise.all([api.get('/api/proxies'), api.get('/api/dashboard')]);
    const identities = dash.rows;
    const withProxy = new Set(list.filter((p) => p.identityId).map((p) => p.identityId));
    const text = h('textarea', { rows: 6, placeholder: 'one proxy per line:\nsocks5://user:pass@host:1080\nhttp://host:3128\nhost:port:user:pass\nhost:port\n\nor JSON: [{ "name": "Exit-01", "type": "SOCKS5", "host": "…", "port": 1080, "username": "…", "password": "…", "expectedPublicIPv4": "…" }]', style: { width: '100%', fontFamily: 'var(--mono)' } });
    const kind = h('select', null, h('option', { value: 'SOCKS5' }, 'SOCKS5'), h('option', { value: 'HTTP' }, 'HTTP'));
    const label = h('input', { placeholder: 'e.g. provider / batch', style: { width: '100%' } });
    const ok = list.filter((p) => p.status === 'OK').length;
    const free = list.filter((p) => p.status === 'OK' && !p.identityId).length;
    const missing = identities.filter((i) => !withProxy.has(i.id)).length;

    const assignSelect = (p) => {
      const sel = h('select', { class: 'small', onchange: (e) => e.target.value && guard(async () => { await api.post(`/api/proxies/${p.id}/assign`, { identityId: Number(e.target.value) }); await render(); }, 'Proxy assigned') },
        h('option', { value: '' }, 'assign to…'),
        identities.filter((i) => !withProxy.has(i.id)).map((i) => h('option', { value: i.id }, i.label)));
      return sel;
    };

    mount(root,
      h('div', { class: 'page-head' }, h('h1', null, 'Proxy pool'),
        h('div', { class: 'toolbar' },
          h('span', { class: 'muted' }, `${list.length} proxies · ${ok} working · ${free} free · ${missing} identities without pool proxy`),
          h('button', { disabled: !list.length, title: 'Checks every proxy: reachable, exit IP, latency (16 at a time)', onclick: (e) => { e.target.disabled = true; e.target.textContent = t(`Testing ${list.length}…`); guard(async () => { const r = await api.post('/api/proxies/test'); await render(); return r; }, null).then((r) => r && toast(`Test finished: ${r.ok} working, ${r.error} failed`, r.error ? 'info' : 'ok', 6000)); } }, 'Test all'),
          h('button', { class: 'primary', disabled: !free || !missing, title: 'Every identity without a pool proxy gets a working proxy with an exit IP no other identity uses', onclick: () => guard(async () => {
            const r = await api.post('/api/proxies/auto-assign');
            await render();
            if (r.skipped.some((s) => !/already has/.test(s.reason))) alert(`${r.assigned.length} assigned. Not assigned:\n${r.skipped.filter((s) => !/already has/.test(s.reason)).map((s) => `identity ${s.identityId}: ${s.reason}`).join('\n')}`);
          }, 'Proxies assigned') }, 'Assign automatically'))),
      h('section', { class: 'card' }, h('h2', null, 'Import'),
        field('Proxy list', text),
        h('div', { class: 'form-grid' }, field('Type for lines without scheme', kind), field('Label', label)),
        h('div', { class: 'form-actions' }, h('button', { class: 'primary', onclick: () => guard(async () => {
          const r = await api.post('/api/proxies/import', { text: text.value, kind: kind.value, label: label.value });
          text.value = '';
          await render();
          if (r.errors.length) alert(`${r.added} imported, ${r.duplicates} already in the pool.\nIgnored lines:\n${r.errors.map((e) => `line ${e.line}: ${e.error}`).join('\n')}`);
          return r;
        }, 'Imported') }, 'Import')),
        h('p', { class: 'muted' }, 'Passwords go straight into the encrypted vault and are never shown again. A proxy assigned to an identity becomes that identity\'s network profile – also when the identity runs on an agent.')),
      list.length
        ? h('section', { class: 'card' }, h('table', null,
            h('thead', null, h('tr', null, ['#', 'Proxy', 'Status', 'Exit IP', 'Latency', 'Identity', ''].map((t) => h('th', null, t)))),
            h('tbody', null, list.map((p) => h('tr', null,
              h('td', { class: 'mono muted' }, String(p.id)),
              h('td', null, h('div', { class: 'mono' }, `${p.kind.toLowerCase()}://${p.username ? `${p.username}${p.hasPassword ? ':•••' : ''}@` : ''}${p.host}:${p.port}`), p.label ? h('div', { class: 'muted' }, p.label) : null),
              h('td', null, h('span', { class: `badge ${STATUS[p.status]}`, title: p.lastError ?? '' }, p.status === 'UNKNOWN' ? 'not tested' : p.status), p.lastCheckedAt ? h('div', { class: 'muted' }, relTime(p.lastCheckedAt)) : null, p.status === 'ERROR' ? h('div', { class: 's-error', style: { fontSize: '12px' } }, p.lastError) : null),
              h('td', null, h('span', { class: 'mono' }, p.exitIp ?? '–'), p.expectedIp && p.expectedIp !== p.exitIp ? h('div', { class: p.exitIp ? 's-warn' : 'muted', style: { fontSize: '12px' } }, `${t('expected')} ${p.expectedIp}`) : null, p.sameExitAs.length ? h('div', { class: 's-warn', style: { fontSize: '12px' }, title: 'These proxies leave through the same IP – auto-assign gives that IP to only one identity' }, `same exit as #${p.sameExitAs.join(', #')}`) : null),
              h('td', { class: 'mono' }, p.latencyMs != null ? `${p.latencyMs} ms` : '–'),
              h('td', null, p.identityId ? h('a', { href: `#/identity/${p.identityId}` }, p.identityLabel ?? `#${p.identityId}`) : assignSelect(p)),
              h('td', null, h('div', { class: 'toolbar' },
                h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/proxies/${p.id}/test`); await render(); }) }, 'Test'),
                p.identityId ? h('button', { class: 'small', onclick: () => guard(async () => { await api.post(`/api/proxies/${p.id}/release`); await render(); }, 'Released') }, 'Release') : null,
                h('button', { class: 'small danger', onclick: () => confirm(`Remove proxy #${p.id}${p.identityId ? ` (used by ${p.identityLabel})` : ''}?`) && guard(async () => { await api.del(`/api/proxies/${p.id}`); await render(); }, 'Removed') }, 'Remove'))))))))
        : h('section', { class: 'card' }, h('p', { class: 'muted' }, 'The pool is empty – import a list above.')));
  };
  await render();
}
