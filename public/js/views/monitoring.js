import { api, qs } from '../api.js';
import { clear, fmtBytes, fmtTime, h, mount, relTime, sparkline, stateBadge } from '../ui.js';

const kpi = (label, value, series, opts) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), series ? sparkline(series, opts) : null);

export async function monitoringView(root) {
  const kpis = h('div', { class: 'kpis' });
  const hosts = h('div', { class: 'card' });
  const problems = h('div', { class: 'card' });
  const alerts = h('div', { class: 'card' });
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Monitoring'), h('div', { class: 'sub' }, 'Main process, supervised runtime hosts and sessions – sampled every 5 s'))),
    kpis, h('div', { class: 'grid-2' }, hosts, problems), alerts);

  const load = async () => {
    const [m, logs] = await Promise.all([api.get('/api/monitoring'), api.get(`/api/logs${qs({ level: 'warn', limit: 30 })}`)]);
    const c = m.current;
    const hist = m.history;
    const series = (f) => hist.map(f);
    mount(kpis,
      kpi('Sessions online', `${c.sessions.online}/${c.sessions.total}`, series((s) => s.sessions.online)),
      kpi('Reconnecting / blocked', `${c.sessions.reconnecting} / ${c.sessions.blocked}`, series((s) => s.sessions.reconnecting + s.sessions.blocked)),
      kpi('RAM (main + hosts)', fmtBytes(c.main.rss + c.hosts.rss), series((s) => s.main.rss + s.hosts.rss)),
      kpi('CPU (main + hosts)', `${(c.main.cpuPercent + c.hosts.cpuPercent).toFixed(1)} %`, series((s) => s.main.cpuPercent + s.hosts.cpuPercent)),
      kpi('Event-loop lag (main / hosts)', `${c.main.eventLoopLagMs} / ${c.hosts.maxLagMs} ms`, series((s) => Math.max(s.main.eventLoopLagMs, s.hosts.maxLagMs))),
      kpi('Network', `in ${fmtBytes(c.network.inPerSec)}/s · out ${fmtBytes(c.network.outPerSec)}/s`, series((s) => s.network.inPerSec + s.network.outPerSec)),
      kpi('Processes / threads', `${c.processes} / ${(c.main.threads ?? 0) + (c.hosts.threads ?? 0) || '–'}`),
      kpi('System', `${fmtBytes(c.system.totalMem - c.system.freeMem)} of ${fmtBytes(c.system.totalMem)} · load ${c.system.load1}`),
      kpi('Game windows', String(c.sessions.gamesOpen)));
    mount(hosts, h('h2', null, `Runtime hosts (${m.hosts.length})`),
      m.hosts.length
        ? h('table', null, h('thead', null, h('tr', null, ['Host', 'PID', 'Sessions', 'RSS', 'CPU', 'Lag', 'Threads', 'Uptime'].map((t) => h('th', null, t)))),
            h('tbody', null, m.hosts.map((x) => h('tr', null, h('td', null, x.hostId), h('td', { class: 'mono' }, String(x.pid)), h('td', { class: 'mono' }, String(x.sessions)),
              h('td', { class: 'mono' }, fmtBytes(x.rss)), h('td', { class: 'mono' }, `${x.cpuPercent}%`), h('td', { class: 'mono' }, `${x.eventLoopLagMs} ms`),
              h('td', { class: 'mono' }, x.threads ?? '–'), h('td', { class: 'muted' }, `${Math.round(x.uptimeSec / 60)} min`)))))
        : h('p', { class: 'muted' }, 'No runtime host running (no active sessions).'),
      h('p', { class: 'muted' }, `Main process pid ${c.main.pid}: ${fmtBytes(c.main.rss)} RSS, heap ${fmtBytes(c.main.heapUsed)}, lag p99 ${c.main.eventLoopLagP99Ms} ms`));
    const bad = m.sessions.filter((s) => ['RECONNECTING', 'BLOCKED'].includes(s.state) || (s.desiredState === 'ONLINE' && s.state === 'STOPPED'));
    mount(problems, h('h2', null, `Sessions needing attention (${bad.length})`),
      bad.length
        ? h('table', null, h('tbody', null, bad.map((s) => h('tr', null, h('td', null, h('a', { href: `#/identity/${s.identityId}/sessions` }, s.id)), h('td', null, s.serverName), h('td', null, stateBadge(s.state)),
            h('td', { class: 'muted', style: { fontSize: '12px' } }, s.state === 'RECONNECTING' ? `next ${relTime(s.nextAttemptAt)} · ` : '', s.lastError ?? '')))))
        : h('p', { class: 's-ok' }, 'All desired sessions are online.'));
    mount(alerts, h('h2', null, 'Recent warnings & errors'),
      logs.length
        ? h('table', null, h('tbody', null, logs.map((e) => h('tr', { class: `log-row ${e.level}` }, h('td', { class: 'mono muted' }, fmtTime(e.ts)), h('td', null, e.scope), h('td', null, e.sessionId ?? ''), h('td', null, e.msg)))))
        : h('p', { class: 'muted' }, 'None.'));
  };
  await load();
  const timer = setInterval(() => document.body.contains(kpis) ? load() : clearInterval(timer), 5000);
  return { onEvent() {} };
}
