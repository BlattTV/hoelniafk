/**
 * Hoelni Client Suite – desktop program (Electron).
 *
 *   Hoelni Client Suite.exe
 *    ├─ own application window (no browser, no address bar) + tray icon
 *    ├─ backend: node supervisor.js → suite (sessions, vault, rules, …)
 *    └─ "Open game" in the suite starts the real Minecraft client as its own window
 *
 * Closing the window keeps the program (and all AFK sessions) running in the tray.
 * "Quit" shuts the backend down gracefully (sessions keep their desired state and
 * are restored on the next start).
 */
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, Notification } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.HOELNI_PORT || 7420);
const BASE = `http://127.0.0.1:${PORT}`;
const HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let backend = null; // only set when this program started the backend
let installBroken = false;

// ------------------------------------------------------------------ language (follows Settings → This PC → Language)
const DE = {
  'No sessions': 'Keine Sessions', 'in game': 'im Spiel', 'Show game window': 'Spielfenster zeigen', 'Open game': 'Spiel öffnen',
  'Back to AFK': 'Zurück zu AFK', 'Stop (set offline)': 'Stoppen (offline schalten)', Start: 'Starten',
  'Open Hoelni Client Suite': 'Hoelni Client Suite öffnen', Sessions: 'Sessions', 'Start with Windows (in the tray)': 'Mit Windows starten (im Tray)',
  'Open data folder': 'Datenordner öffnen', 'Quit (sessions go offline)': 'Beenden (Sessions gehen offline)',
  'Installing components…': 'Komponenten werden installiert…',
  'Some packages of the suite were missing and are being installed (needs internet, about a minute).': 'Einige Pakete der Suite fehlten und werden installiert (braucht Internet, etwa eine Minute).',
  'The suite is not installed completely': 'Die Suite ist nicht vollständig installiert',
  'Installing the missing packages failed – see the log below.': 'Die fehlenden Pakete konnten nicht installiert werden – siehe Log unten.',
  'Some packages are missing – see the log below for the fix.': 'Einige Pakete fehlen – die Lösung steht im Log unten.',
  'Starting Hoelni Client Suite …': 'Hoelni Client Suite startet …', 'Starting the backend and restoring your sessions.': 'Starte die Suite und stelle deine Sessions wieder her.',
  'Still running in the tray – your AFK sessions stay online.': 'Läuft im Tray weiter – deine AFK-Sessions bleiben online.',
};
let uiLang = 'en';
const langFile = () => path.join(app.getPath('userData'), 'ui-language');
const L = (s) => (uiLang === 'de' ? DE[s] ?? s : s);
function loadLang() {
  try {
    uiLang = fs.readFileSync(langFile(), 'utf8').trim() === 'de' ? 'de' : 'en';
  } catch {
    uiLang = 'en';
  }
}
function rememberLang(next) {
  if (next === uiLang) return;
  uiLang = next;
  try {
    fs.writeFileSync(langFile(), next);
  } catch {}
}
let quitting = false;
let trayHintShown = false;

// ------------------------------------------------------------------ backend location

function backendRoot() {
  // packaged: resources/backend (dist, public, config, node_modules); development: the repository
  const packaged = path.join(process.resourcesPath || '', 'backend');
  if (app.isPackaged && fs.existsSync(path.join(packaged, 'dist', 'supervisor.js'))) return packaged;
  return path.resolve(__dirname, '..');
}

function nodeBinary(root) {
  if (process.env.HOELNI_NODE) return process.env.HOELNI_NODE;
  const bundled = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  return fs.existsSync(bundled) ? bundled : 'node';
}

function dataDir() {
  if (process.env.HOELNI_DATA_DIR) return process.env.HOELNI_DATA_DIR;
  // installed program: per-user data; development: the repository's data folder
  return app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(backendRoot(), 'data');
}

async function backendUp() {
  try {
    const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function logFile() {
  const dir = path.join(dataDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'desktop-backend.log');
}

function startBackend() {
  const root = backendRoot();
  const entry = path.join(root, 'dist', 'supervisor.js');
  if (!fs.existsSync(entry)) throw new Error(`Backend not built: ${entry} missing (run "npm run build" in the repository)`);
  const out = fs.openSync(logFile(), 'a');
  const env = { ...process.env, HOELNI_DATA_DIR: dataDir(), HOELNI_PORT: String(PORT), HOELNI_DESKTOP: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const userConfig = path.join(app.getPath('userData'), 'app.yaml');
  if (!env.HOELNI_CONFIG && fs.existsSync(userConfig)) env.HOELNI_CONFIG = userConfig;
  backend = spawn(nodeBinary(root), [entry], { cwd: root, env, stdio: ['ignore', out, out, 'ipc'], windowsHide: true });
  backend.on('exit', (code) => {
    backend = null;
    if (quitting) return;
    if (code === 3) {
      // Missing packages: reinstall them once with the bundled npm, then start again.
      if (!repairTried && repairPackages(root)) {
        repairTried = true;
        showStatus(L('Installing components…'), L('Some packages of the suite were missing and are being installed (needs internet, about a minute).'), {});
        return void runRepair(root).then((ok) => {
          if (ok && !quitting) startBackend();
          else {
            installBroken = true;
            showStatus(L('The suite is not installed completely'), L('Installing the missing packages failed – see the log below.'), { log: logTail(), error: true });
          }
        });
      }
      installBroken = true;
      showStatus(L('The suite is not installed completely'), L('Some packages are missing – see the log below for the fix.'), { log: logTail(), error: true });
      return;
    }
    // The supervisor itself restarts crashed suites; if it is gone, bring it back.
    setTimeout(() => {
      if (!quitting) {
        try {
          startBackend();
        } catch (e) {
          dialog.showErrorBox('Hoelni Client Suite', String(e.message || e));
        }
      }
    }, 3000);
    console.error(`backend exited with code ${code}`);
  });
}

let repairTried = false;

/** Bundled npm (resources/backend/node/node_modules/npm) – present in installed programs. */
function repairPackages(root) {
  const cli = path.join(root, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(cli) && fs.existsSync(path.join(root, 'package-lock.json')) ? cli : null;
}

function runRepair(root) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile(), 'a');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(nodeBinary(root), [repairPackages(root), 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, env, stdio: ['ignore', out, out], windowsHide: true });
    p.on('exit', (c) => resolve(c === 0));
    p.on('error', () => resolve(false));
  });
}

async function ensureBackend() {
  if (await backendUp()) return; // e.g. started by the autostart task – just attach
  startBackend();
  let deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (repairTried && !installBroken && deadline - Date.now() < 60_000) deadline = Date.now() + 60_000; // package repair running
    if (installBroken) throw new Error('The suite is not installed completely – packages are missing (see the log).');
    if (await backendUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  let tail = '';
  try {
    tail = fs.readFileSync(logFile(), 'utf8').split('\n').slice(-15).join('\n');
  } catch {}
  throw new Error(`The suite did not start within 90 s – see the log below.\n\n${tail}`);
}

// ------------------------------------------------------------------ status screen (shown until the suite answers)

function logTail(lines = 25) {
  try {
    return fs.readFileSync(logFile(), 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function statusPage(title, detail, { log = '', error = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hoelni Client Suite</title><style>
    body{margin:0;font:14px/1.5 'Segoe UI',system-ui,sans-serif;background:#1b1a17;color:#e9e5da;display:grid;place-items:center;min-height:100vh}
    main{width:min(820px,92vw)} .mark{width:24px;height:24px;display:inline-block;vertical-align:middle;margin-right:10px;background:linear-gradient(#5f8f3e 0 33%,#7a5536 33%)}
    h1{font-size:20px;margin:0 0 6px} p{color:#9c968a;margin:4px 0 14px} .err h1{color:#e07b61}
    pre{background:#22211d;border:1px solid #37342d;padding:10px 12px;max-height:50vh;overflow:auto;font:12px/1.45 'Cascadia Mono',Consolas,monospace;white-space:pre-wrap}
    .bar{height:3px;background:#37342d;overflow:hidden;margin:14px 0}.bar i{display:block;height:100%;width:30%;background:#93b872;animation:m 1.2s linear infinite}
    @keyframes m{from{margin-left:-30%}to{margin-left:100%}} code{color:#93b872}</style></head>
    <body><main class="${error ? 'err' : ''}"><h1><span class="mark"></span>${esc(title)}</h1><p>${esc(detail)}</p>
    ${error ? '' : '<div class="bar"><i></i></div>'}
    ${log ? `<p>Last lines of <code>${esc(logFile())}</code>:</p><pre>${esc(log)}</pre>` : ''}
    ${error ? '<p>The window retries automatically. <b>F5</b> retries now, <b>Ctrl+Shift+I</b> opens the developer tools.</p>' : ''}
    </main></body></html>`;
}

function showStatus(title, detail, opts) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusPage(title, detail, opts))}`).catch(() => undefined);
}

let suiteShown = false;
let retryTimer = null;

async function loadSuite() {
  clearTimeout(retryTimer);
  if (!(await backendUp())) {
    showStatus('Waiting for the suite …', `Nothing answers on ${BASE} yet.`, { log: logTail(), error: true });
    retryTimer = setTimeout(loadSuite, 3000);
    return;
  }
  try {
    await win.loadURL(`${BASE}/`);
    suiteShown = true;
  } catch (e) {
    suiteShown = false;
    showStatus('The suite could not be loaded', `${e.message || e}`, { log: logTail(), error: true });
    retryTimer = setTimeout(loadSuite, 3000);
  }
}

// ------------------------------------------------------------------ window & tray

function icon(name) {
  return nativeImage.createFromPath(path.join(__dirname, 'build', name));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'Hoelni Client Suite',
    icon: icon('icon.png'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: !HIDDEN,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  showStatus(L('Starting Hoelni Client Suite …'), L('Starting the backend and restoring your sessions.'));
  // Keys the removed menu used to provide: reload, developer tools.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      void loadSuite();
    } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
  // The suite page failed (backend restarting, …): show why and retry.
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || url.startsWith('data:') || code === -3) return;
    suiteShown = false;
    showStatus('The suite is not reachable', `${description} (${code}) – retrying …`, { log: logTail(), error: true });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(loadSuite, 3000);
  });
  win.webContents.on('render-process-gone', () => {
    suiteShown = false;
    retryTimer = setTimeout(loadSuite, 1000);
  });
  // Everything outside the suite (Discord verification links, webmail, OAuth) opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const discord = /\/api\/identities\/(\d+)\/discord\/open\?/.exec(url);
    if (discord && url.startsWith(BASE)) {
      void openDiscordProfile(Number(discord[1]), url);
      return { action: 'deny' };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Hoelni Client Suite', body: L('Still running in the tray – your AFK sessions stay online.') }).show();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ------------------------------------------------------------------ tray: sessions at a glance

let apiToken = null;
let traySessions = [];

async function api(method, p) {
  if (!apiToken) {
    const html = await (await fetch(`${BASE}/`)).text();
    apiToken = /name="hoelni-token" content="([^"]+)"/.exec(html)?.[1] ?? null;
  }
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'x-hoelni-token': apiToken ?? '', ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: BASE }) },
    body: method === 'GET' ? undefined : '{}',
  });
  if (res.status === 401) apiToken = null; // the backend restarted (new token)
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function refreshTray() {
  try {
    const [sessions, dash, ui] = await Promise.all([api('GET', '/api/sessions'), api('GET', '/api/dashboard'), api('GET', '/api/settings/ui').catch(() => null)]);
    if (ui) rememberLang(ui.language === 'de' ? 'de' : 'en');
    const names = new Map(dash.rows.map((r) => [r.id, r.label || `Identity${String(r.number).padStart(2, '0')}`]));
    traySessions = sessions.map((s) => ({ ...s, who: `${names.get(s.identityId) ?? s.identityId} @ ${s.serverName}` }));
    const online = traySessions.filter((s) => s.state === 'ONLINE').length;
    tray?.setToolTip(`Hoelni Client Suite – ${online}/${traySessions.filter((s) => s.desiredState === 'ONLINE').length} ${uiLang === 'de' ? 'Sessions online' : 'sessions online'}`);
  } catch {
    /* backend restarting */
  }
  tray?.setContextMenu(trayMenu());
}

function sessionItems() {
  if (!traySessions.length) return [{ label: L('No sessions'), enabled: false }];
  const act = (method, p) => () => api(method, p).then(refreshTray).catch((e) => new Notification({ title: 'Hoelni', body: `Action failed (${e.message})` }).show());
  return traySessions.slice(0, 40).map((s) => {
    const inGame = s.runtime === 'game' || s.takeover !== 'none';
    return {
      label: `${s.who}  –  ${inGame ? L('in game') : s.state.toLowerCase()}`,
      submenu: [
        { label: L(inGame ? 'Show game window' : 'Open game'), click: act('POST', `/api/sessions/${encodeURIComponent(s.id)}/game`) },
        ...(inGame ? [{ label: L('Back to AFK'), click: act('DELETE', `/api/sessions/${encodeURIComponent(s.id)}/game`) }] : []),
        { type: 'separator' },
        s.desiredState === 'ONLINE'
          ? { label: L('Stop (set offline)'), click: act('POST', `/api/sessions/${encodeURIComponent(s.id)}/stop`) }
          : { label: L('Start'), click: act('POST', `/api/identities/${s.identityId}/sessions/${s.serverId}/start`) },
      ],
    };
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
      { label: L('Open Hoelni Client Suite'), click: showWindow },
      { label: L('Sessions'), submenu: sessionItems() },
      { type: 'separator' },
      {
        label: L('Start with Windows (in the tray)'),
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { label: L('Open data folder'), click: () => shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: L('Quit (sessions go offline)'), click: () => quit() },
    ]);
}

// ------------------------------------------------------------------ Discord: one browser profile per identity
// Each identity gets its own persistent Discord login (like browser containers). "Switching" accounts
// = opening the window of another identity. The suite only opens pages here – it never fills in or
// submits Discord forms, reads Discord pages or uses Discord tokens (no automation, no self-bots).
const discordWindows = new Map();

async function openDiscordProfile(identityId, url) {
  let w = discordWindows.get(identityId);
  if (!w || w.isDestroyed()) {
    let label = `Identity ${identityId}`;
    try {
      const list = await api('GET', '/api/discord');
      const row = list.find((r) => r.identityId === identityId);
      if (row) label = row.discord?.username ? `${row.label} · @${row.discord.username}` : row.label;
    } catch {}
    w = new BrowserWindow({
      width: 1200,
      height: 820,
      title: `Discord – ${label}`,
      icon: icon('icon.png'),
      autoHideMenuBar: true,
      webPreferences: { partition: `persist:hoelni-discord-${identityId}`, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    w.removeMenu();
    const title = `Discord – ${label}`;
    w.on('page-title-updated', (e) => {
      e.preventDefault();
      w.setTitle(title);
    });
    // Discord's own popups (captcha, OAuth) stay in the same profile; other sites open in the normal browser.
    w.webContents.setWindowOpenHandler(({ url: next }) => {
      try {
        const host = new URL(next).hostname;
        if (/(^|\.)(discord\.com|discordapp\.com|discord\.gg|hcaptcha\.com)$/.test(host)) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: `persist:hoelni-discord-${identityId}`, contextIsolation: true, sandbox: true } } };
        }
      } catch {}
      if (/^https?:\/\//.test(next)) shell.openExternal(next);
      return { action: 'deny' };
    });
    discordWindows.set(identityId, w);
    w.on('closed', () => discordWindows.delete(identityId));
  }
  // The suite URL answers with a redirect to the Discord page (or the OAuth consent page).
  await w.loadURL(url).catch(() => undefined);
  w.show();
  w.focus();
}

function createTray() {
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Hoelni Client Suite');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
  tray.on('right-click', () => void refreshTray());
}

async function quit() {
  quitting = true;
  if (backend) {
    const b = backend;
    const gone = new Promise((r) => b.once('exit', r));
    try {
      b.send({ cmd: 'shutdown' }); // graceful: game windows closed, sessions keep their desired state
    } catch {
      b.kill();
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 30_000))]);
    if (backend) backend.kill();
  }
  app.exit(0);
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault();
    quit();
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('net.hoelni.clientsuite');
  loadLang();
  createTray();
  createWindow(); // shows the status screen right away
  try {
    await ensureBackend();
  } catch (e) {
    // Keep the window open with the reason and the log – far more useful than a dialog that closes everything.
    showStatus('Hoelni Client Suite could not start', String(e.message || e).split('\n')[0], { log: logTail(40), error: true });
    retryTimer = setTimeout(loadSuite, 5000);
    return;
  }
  await loadSuite();
  void refreshTray();
  setInterval(() => void refreshTray(), 15_000);
});
