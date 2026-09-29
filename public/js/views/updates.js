import { api, recoverAfterRestart } from '../api.js';
import { field, fmtBytes, fmtTime, guard, h, modal, relTime } from '../ui.js';

/** Settings → Updates: self-hosted update server (update-server/ in a LXC). */
export function updatesCard(st, rerender, backend = null) {
  const s = st.settings;
  const url = h('input', { value: s.url, placeholder: backend?.updatesUrl ?? 'https://afk.hoelni.de/updates', style: { width: '100%' } });
  const channel = h('input', { value: s.channel, style: { width: '100%' } });
  const autoCheck = h('input', { type: 'checkbox', checked: s.autoCheck });
  const autoInstall = h('input', { type: 'checkbox', checked: s.autoInstall });
  const m = st.latest;
  const connect = () => guard(async () => {
    const probe = await api.post('/api/updates/probe', { url: url.value });
    await new Promise((resolve, reject) => {
      let dlg = null;
      const done = (fn) => { dlg?.close(); fn(); };
      dlg = modal('Confirm the update server key', h('div', null,
        h('p', null, 'Compare this fingerprint with the one printed by the installer / shown on the server\'s status page (', h('code', null, 'hoelni-updates info'), '). Only releases signed with this key will be installed.'),
        h('p', null, h('code', { style: { fontSize: '15px' } }, probe.fingerprint)),
        h('div', { class: 'form-actions' },
          h('button', { class: 'primary', onclick: () => api.put('/api/updates/settings', { url: url.value, channel: channel.value, publicKey: probe.publicKey }).then(() => done(resolve), (e) => done(() => reject(e))) }, 'Fingerprint matches – trust this server'),
          h('button', { onclick: () => done(() => reject(new Error('Not connected – key not confirmed'))) }, 'Cancel'))));
    });
    await api.post('/api/updates/check');
    await rerender();
  }, 'Update server connected');
  const viaBackend = backend && backend.state !== 'signed-out' && backend.updatesUrl;
  const useBackend = () => {
    url.value = backend.updatesUrl;
    return connect();
  };
  const cur = st.current;
  return h('section', { class: 'card', id: 'updates-card' },
    h('h2', null, 'Updates'),
    h('div', { class: 'kv' },
      h('div', null, 'Installed'), h('div', { class: 'mono' }, `${cur.version}${cur.build ? ` · build #${cur.build}` : ' · from source checkout'}${cur.commit ? ` · ${cur.commit.slice(0, 7)}` : ''}`),
      h('div', null, 'Update server'), h('div', { class: 'mono' }, s.url || '– not configured –'),
      h('div', null, 'Signing key'), h('div', { class: 'mono' }, s.keyFingerprint ?? '– not confirmed –'),
      h('div', null, 'Latest release'), h('div', null, m ? `${m.version} (build #${m.build}, ${fmtTime(m.createdAt)})` : st.lastCheckAt ? '–' : 'not checked yet'),
      h('div', null, 'Status'), h('div', { class: st.state === 'error' ? 's-error' : st.available ? 's-info' : 's-ok' },
        st.state === 'downloading' && st.progress ? `downloading ${fmtBytes(st.progress.done)} / ${fmtBytes(st.progress.total)}` :
        st.state === 'staged' || st.pending ? `update #${st.pending?.build ?? ''} downloaded – installs on restart` :
        st.state === 'restarting' ? 'restarting to install…' :
        st.state === 'error' ? st.error :
        st.available ? 'update available' : st.lastCheckAt ? `up to date (checked ${relTime(st.lastCheckAt)})` : '–'),
      st.lastApplied ? h('div', null, 'Last update') : null, st.lastApplied ? h('div', null, `#${st.lastApplied.build} applied ${fmtTime(st.lastApplied.at)}${st.lastApplied.stable ? '' : ' (probation)'}`) : null,
      st.lastFailed ? h('div', null, 'Last problem') : null, st.lastFailed ? h('div', { class: 's-error' }, `#${st.lastFailed.build}: ${st.lastFailed.error}`) : null),
    m && st.available && m.notes?.length ? h('div', null, h('h3', null, 'Changes'), h('ul', null, m.notes.slice(0, 15).map((n) => h('li', null, n)))) : null,
    h('div', { class: 'form-actions' },
      st.available ? h('button', { class: 'primary', title: 'Downloads, verifies (signature + SHA-256) and restarts the suite; sessions come back automatically', onclick: () => guard(async () => {
        const r = await api.post('/api/updates/install');
        if (r?.state === 'restarting') return void recoverAfterRestart({ expectRestart: true, message: 'Installing the update – the suite restarts…' });
        await rerender();
      }, st.supervised ? null : 'Downloaded – restart the suite to apply') }, st.pending ? 'Restart & install' : 'Install update') : null,
      h('button', { disabled: !s.url || !s.keyFingerprint, onclick: () => guard(async () => { await api.post('/api/updates/check'); await rerender(); }) }, 'Check now'),
      st.installerUrl ? h('a', { class: 'btn-link', href: api.downloadUrl(st.installerUrl), title: 'New desktop program installer (window/tray program itself)' }, `Desktop installer ${m?.installer?.desktopVersion ?? ''}`) : null,
      st.lastApplied ? h('button', { class: 'danger', title: 'Restore the version before the last update', onclick: () => guard(async () => {
        const r = await api.post('/api/updates/rollback');
        if (r?.state === 'restarting') return void recoverAfterRestart({ expectRestart: true, message: 'Restoring the previous version – the suite restarts…' });
        await rerender();
      }) }, 'Roll back last update') : null),
    h('h3', null, 'Update server'),
    h('div', { class: 'form-grid' }, field('URL', url), field('Channel', channel)),
    h('div', { class: 'toolbar' },
      h('label', { class: 'check' }, autoCheck, 'Check automatically'),
      h('label', { class: 'check', title: 'Only while no game window is open' }, autoInstall, 'Install automatically')),
    h('div', { class: 'form-actions' },
      viaBackend && s.url !== backend.updatesUrl ? h('button', { class: 'primary', title: `Receive updates from ${backend.updatesUrl} (signed-in devices only)`, onclick: useBackend }, 'Get updates via the backend') : null,
      h('button', { class: viaBackend && s.url !== backend.updatesUrl ? '' : 'primary', onclick: connect }, s.keyFingerprint ? 'Reconnect / confirm key' : 'Connect'),
      h('button', { onclick: () => guard(async () => { await api.put('/api/updates/settings', { channel: channel.value, autoCheck: autoCheck.checked, autoInstall: autoInstall.checked }); await rerender(); }, 'Saved') }, 'Save options')),
    h('p', { class: 'muted' }, 'Install the update server in your LXC with one command – see update-server/README.md. Releases are Ed25519-signed; the suite only installs releases signed with the confirmed key, applies them during a restart and restores the previous version automatically if the new one fails to start.'));
}
