/**
 * Stars – balance of all identities, gained per 24 h / 7 / 30 days / year with a chart, and the
 * balance per identity and server (with a manual correction). Only servers with "Count stars" count.
 */
import { api } from '../api.js';
import { guard, h, mount, pad2 } from '../ui.js';
import { lang, t } from '../i18n.js';

const fmt = (n) => Number(n || 0).toLocaleString(document.documentElement.lang === 'de' ? 'de-DE' : 'en-US');
let range = 'day';

/** Alerts when star earning is abnormal (the Hoelni Control app shows them as phone notifications). */
function alertsCard(al) {
  const cfg = al.settings;
  const num = (v, min, max, step = 1) => h('input', { type: 'number', min, max, step, value: v, style: { width: '80px' } });
  const enabled = h('input', { type: 'checkbox', checked: cfg.enabled });
  const stallFactor = num(cfg.stallFactor, 1.5, 20, 0.5);
  const stallMin = num(cfg.stallMinMinutes, 15, 1440);
  const spikeFactor = num(cfg.spikeFactor, 1.5, 50, 0.5);
  const spikeMin = num(cfg.spikeMin, 1, 10000);
  const dropMin = num(cfg.dropMin, 0, 100000);
  const line = (...parts) => h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' } }, ...parts);
  const when = (iso) => new Date(iso).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const KIND = { stall: 'No stars', spike: 'Unusually many', drop: 'Stars lost', test: 'Test alert' };
  return h('section', { class: 'card' },
    h('h2', null, 'Alerts'),
    h('p', { class: 'muted' }, 'Compares every online account with its own pace of the last 7 days and warns when something is off. New alerts appear as a notification in the Hoelni Control app on the phone.'),
    h('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, enabled, h('span', null, 'Alerts on')),
    line(h('span', null, 'No star for'), stallFactor, h('span', null, 'times the usual gap, at least'), stallMin, h('span', null, 'minutes')),
    line(h('span', null, 'More than'), spikeFactor, h('span', null, 'times the usual stars per hour, at least'), spikeMin, h('span', null, 'stars')),
    line(h('span', null, 'Lost at least'), dropMin, h('span', null, 'stars within an hour (0 = off)')),
    h('div', { class: 'form-actions' },
      h('button', { class: 'primary', onclick: () => guard(() => api.put('/api/stars/alerts/settings', { enabled: enabled.checked, stallFactor: Number(stallFactor.value), stallMinMinutes: Number(stallMin.value), spikeFactor: Number(spikeFactor.value), spikeMin: Number(spikeMin.value), dropMin: Number(dropMin.value) }), 'Saved') }, 'Save'),
      h('button', { onclick: () => guard(() => api.post('/api/stars/alerts/test'), 'Test alert sent – the phone shows it within 15 minutes') }, 'Send test alert')),
    al.alerts.length
      ? h('table', null, h('tbody', null, al.alerts.slice(0, 10).map((a) => h('tr', null,
          h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, when(a.ts)),
          h('td', null, h('span', { class: `tag ${a.kind === 'test' ? '' : 'warn'}` }, KIND[a.kind] ?? a.kind)),
          h('td', null, [a.name, a.server].filter(Boolean).join(' · ')),
          h('td', { class: 'wrap' }, lang === 'de' ? a.textDe : a.text)))))
      : h('p', { class: 'muted' }, 'No alerts so far.'));
}

/** One series of bars (stars gained), one hue; hover / click shows the value of a bar. */
function chart(points, label, caption) {
  const W = 720;
  const H = 150;
  const NS = 'http://www.w3.org/2000/svg';
  const max = Math.max(1, ...points.map((p) => p.gained));
  const step = W / points.length;
  const bw = Math.max(2, step - 2); // 2px gap
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H + 1}`, class: 'stars-chart', role: 'img', 'aria-label': caption.textContent });
  svg.append(el('line', { x1: 0, x2: W, y1: 10, y2: 10, class: 'grid' }));
  const def = caption.textContent;
  points.forEach((p, i) => {
    const x = i * step + (step - bw) / 2;
    const hgt = p.gained ? Math.max(3, (p.gained / max) * (H - 14)) : 0;
    if (hgt) {
      const r = Math.min(4, bw / 2, hgt);
      const y = H - hgt;
      svg.append(el('path', { class: 'bar', d: `M${x},${H} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H} Z` }));
    }
    const hit = el('rect', { x: i * step, y: 0, width: step, height: H, class: 'hit' });
    const show = () => {
      caption.textContent = `${label(p)}: +${fmt(p.gained)} ★`;
      svg.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
      hit.classList.add('on');
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('click', show);
    svg.append(hit);
  });
  svg.addEventListener('pointerleave', () => {
    caption.textContent = def;
    svg.querySelectorAll('.hit.on').forEach((n) => n.classList.remove('on'));
  });
  svg.append(el('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'axis' }));
  return svg;
}

export async function starsView(root) {
  const render = async () => {
    const [st, al] = await Promise.all([api.get('/api/stars'), api.get('/api/stars/alerts').catch(() => null)]);
    const daily = range === 'day';
    const pts = daily ? st.hourly : st.daily;
    const sum = pts.reduce((a, p) => a + p.gained, 0);
    const caption = h('div', { class: 'muted stars-cap' }, `+${fmt(sum)} ★ ${t(daily ? 'in the last 24 hours' : 'in the last 30 days')}`);
    const label = daily
      ? (p) => t(`${pad2(new Date(p.t).getHours())}–${pad2((new Date(p.t).getHours() + 1) % 24)} o'clock`)
      : (p) => new Date(`${p.day}T12:00:00`).toLocaleDateString(document.documentElement.lang === 'de' ? 'de-DE' : 'en-US', { weekday: 'short', day: 'numeric', month: 'numeric' });
    const kpi = (v, text) => h('div', { class: 'stat' }, h('b', null, `+${fmt(v)}`), h('span', null, text));
    const counted = st.servers.filter((s) => s.trackStars);
    const correct = (i, s) => {
      const v = prompt(t(`Actual star balance of ${i.name} on ${s.name}:`), String(s.stars));
      if (v === null) return;
      const n = Number(String(v).replace(/[.\s,']/g, ''));
      if (!Number.isInteger(n) || n < 0) return alert(t('Please enter a whole number.'));
      void guard(async () => { await api.patch(`/api/identities/${i.id}/rewards/servers/${s.serverId}`, { stars: n }); await render(); }, 'Corrected');
    };
    mount(root,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Stars'), h('div', { class: 'sub' }, `${t('Counted on')}: ${counted.map((s) => s.name).join(', ') || t('no server')} · `, h('a', { href: '#/servers' }, t('change under Servers'))))),
      h('div', { class: 'stats-row' },
        h('div', { class: 'stat big' }, h('b', null, fmt(st.total)), h('span', null, 'Stars of all identities')),
        h('div', { class: 'stat big' }, h('b', null, fmt(st.online)), h('span', null, 'on the identities online now')),
        kpi(st.gained.h24, '24 hours'), kpi(st.gained.d7, '7 days'), kpi(st.gained.d30, '30 days'), kpi(st.gained.d365, '1 year')),
      h('section', { class: 'card' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } },
          h('h2', null, 'Stars gained'),
          h('div', { class: 'seg' },
            h('button', { class: daily ? 'on' : '', onclick: () => { range = 'day'; void render(); } }, '24 h'),
            h('button', { class: daily ? '' : 'on', onclick: () => { range = 'month'; void render(); } }, '30 days'))),
        caption,
        chart(pts, label, caption),
        h('div', { class: 'stars-x muted' }, h('span', null, daily ? '−24 h' : '−30 d'), h('span', null, t(daily ? 'now' : 'today')))),
      al ? alertsCard(al) : null,
      h('section', { class: 'card' },
        h('h2', null, 'Per identity'),
        h('p', { class: 'muted' }, 'The balance comes from the scoreboard on the right in the game; without one, from chat messages (then only the stars gained since the suite counts). If a balance is wrong, correct it once – later changes count from there.'),
        h('table', null,
          h('thead', null, h('tr', null, ['Identity', 'Balance', '24 h', '7 days', '30 days', 'Per server'].map((x) => h('th', null, x)))),
          h('tbody', null, st.perIdentity.map((i) => h('tr', null,
            h('td', null, h('span', { class: `dot ${i.online ? 'on' : ''}`, style: { marginLeft: '0' } }), ' ', h('a', { href: `#/identity/${i.id}` }, i.name)),
            h('td', { class: 'num' }, fmt(i.stars)),
            h('td', { class: 'num' }, i.h24 ? `+${fmt(i.h24)}` : '–'),
            h('td', { class: 'num' }, i.d7 ? `+${fmt(i.d7)}` : '–'),
            h('td', { class: 'num' }, i.d30 ? `+${fmt(i.d30)}` : '–'),
            h('td', null, (i.servers ?? []).length
              ? (i.servers ?? []).map((s) => h('div', { class: 'row', style: { gap: '8px', margin: '3px 0' } },
                  h('span', null, `${s.name}: ${fmt(s.stars)}`),
                  s.source === 'scoreboard' ? h('span', { class: 'tag', title: t('Read from the scoreboard') }, 'scoreboard') : s.source === 'chat' ? h('span', { class: 'tag', title: t('Counted from chat messages only') }, 'chat') : null,
                  h('button', { class: 'small', onclick: () => correct(i, s) }, 'Correct')))
              : h('span', { class: 'muted' }, '–'))))))),
      h('p', { class: 'muted' }, `${t('Updated')}: ${new Date(st.at).toLocaleTimeString()}`));
  };
  await render();
  let tm;
  return { onEvent: (ev) => { if (ev.type === 'reward.changed' || ev.type === 'stars.alert') { clearTimeout(tm); tm = setTimeout(render, 1500); } } };
}
