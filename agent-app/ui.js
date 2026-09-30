/* Hoelni Agent window – talks to main.cjs through window.agent (preload). */
const $ = (id) => document.getElementById(id);
const STATE = { connecting: 'verbindet…', online: 'verbunden', offline: 'offline – versucht erneut', paused: 'pausiert', revoked: 'abgemeldet' };
let info = null;
let pendingFingerprint = null;

function text(el, value) {
  el.textContent = value ?? '';
}

function renderInfo() {
  const signedIn = !!info?.signedIn;
  $('login').hidden = signedIn;
  $('status').hidden = !signedIn;
  $('sessions').hidden = !signedIn;
  text($('login-backend'), info?.backendUrl);
  text($('backend'), info?.backendUrl);
  text($('account'), info?.username ?? '–');
  text($('pcname'), info?.name ?? '–');
  if (!$('name').value && info?.name) $('name').value = info.name;
}

function renderStatus(st) {
  if (!st) {
    text($('state'), info?.signedIn ? 'startet…' : '');
    $('state').className = 'state';
    return;
  }
  text($('state'), STATE[st.state] ?? st.state);
  $('state').className = `state s-${st.state}`;
  text($('manager'), st.state === 'online' ? (st.managerOnline ? 'Verwaltung verbunden' : 'Verwaltung gerade offline – es läuft nichts') : '');
  text($('lasterror'), st.lastError || '–');
  $('pause-btn').hidden = st.state === 'paused' || st.state === 'revoked';
  $('resume-btn').hidden = st.state !== 'paused';
  const list = $('session-list');
  list.replaceChildren();
  if (!st.sessions?.length) text(list, st.state === 'paused' ? 'Pausiert – es werden keine Sessions gestartet.' : 'Nichts.');
  else {
    const ul = document.createElement('ul');
    for (const s of st.sessions) {
      const li = document.createElement('li');
      li.textContent = `${s.username} auf ${s.server} – ${s.phase}`;
      ul.appendChild(li);
    }
    list.appendChild(ul);
  }
  text($('game'), st.game ? `Minecraft-Fenster: ${st.game.status}` : '');
  const u = st.update;
  if (u) {
    const upd = { staged: ' · Update bereit – wird installiert, sobald hier nichts läuft', downloading: ' · Update wird geladen…', restarting: ' · Update wird installiert…', error: '' }[u.state] ?? '';
    text($('version'), `${appVersion ? `v${appVersion} · ` : ''}Build ${u.build || '–'}${upd}`);
  }
  if (st.state === 'revoked') void load();
}

let appVersion = '';

async function load() {
  const r = await window.agent.info();
  info = r.info;
  appVersion = r.version || '';
  text($('version'), r.version ? `v${r.version}` : '');
  $('autostart').checked = !!r.autostart;
  renderInfo();
  renderStatus(r.status);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

$('login-btn').addEventListener('click', () => busy($('login-btn'), async () => {
  text($('login-error'), '');
  const r = await window.agent.login($('user').value.trim(), $('pw').value, $('name').value.trim(), pendingFingerprint);
  if (r.ok) {
    $('pw').value = '';
    pendingFingerprint = null;
    $('trust').hidden = true;
    $('login-btn').textContent = 'Anmelden';
    await load();
    return;
  }
  if (r.needsTrust) {
    // Show the fingerprint; the next click confirms exactly this certificate.
    pendingFingerprint = r.fingerprint;
    text($('fp'), r.fingerprint);
    $('trust').hidden = false;
    $('login-btn').textContent = 'Fingerabdruck stimmt – anmelden';
    if (r.error && /changed/.test(r.error)) text($('login-error'), 'Das Zertifikat hat sich geändert – bitte erneut vergleichen.');
    return;
  }
  text($('login-error'), r.error || 'Anmeldung fehlgeschlagen');
}));

$('pw').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('login-btn').click();
});

$('pause-btn').addEventListener('click', () => window.agent.pause());
$('resume-btn').addEventListener('click', () => window.agent.resume());
$('logout-btn').addEventListener('click', () => busy($('logout-btn'), async () => {
  if (!confirm('Diesen PC abmelden? Danach laufen hier keine Sessions mehr.')) return;
  await window.agent.logout();
  await load();
}));

$('autostart').addEventListener('change', async (e) => {
  e.target.checked = await window.agent.setAutostart(e.target.checked);
});

$('proxy-btn').addEventListener('click', () => busy($('proxy-btn'), async () => {
  text($('settings-error'), '');
  const r = await window.agent.setProxy($('proxy').value.trim());
  text($('settings-error'), r.ok ? '' : r.error);
  if (r.ok) $('proxy').value = '';
  $('proxy').placeholder = info?.proxy || r.proxy ? 'Proxy gesetzt (leer speichern = entfernen)' : 'socks5://benutzer:passwort@host:1080 oder http://host:3128';
  await load();
}));

$('change-btn').addEventListener('click', () => busy($('change-btn'), async () => {
  text($('settings-error'), '');
  const r = await window.agent.changeBackend($('new-url').value.trim(), $('admin-user').value.trim(), $('admin-pw').value);
  $('admin-pw').value = '';
  if (!r.ok) return text($('settings-error'), r.error);
  $('new-url').value = '';
  await load();
}));

window.agent.onStatus(renderStatus);
window.agent.onAutostart?.((on) => ($('autostart').checked = !!on)); // changed in the tray menu
void load().then(() => {
  if (info?.proxy) $('proxy').placeholder = 'Proxy gesetzt (leer speichern = entfernen)';
});
