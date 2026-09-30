/**
 * Hoelni Agent – Windows program for other households.
 *
 *   Sign in once with the Hoelni account → this PC connects to the backend (afk.hoelni.de)
 *   and the account's manager can run AFK sessions here. The household sees what runs
 *   (window + tray) and can pause at any time.
 *
 * The agent process itself is dist/agent/main.js (bundled Node, resources/runtime);
 * this Electron shell only shows the login/status window and the tray.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification } = require('electron');

// ------------------------------------------------------------------ start with Windows
// The entry starts the program hidden in the tray (--hidden). Windows only reports it as set when it is
// queried with the same arguments – without them the checkbox always read "off" and jumped back.
const LOGIN_ITEM = { args: ['--hidden'] };
function autostartOn() {
  return app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;
}
function setAutostart(on) {
  app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: !!on });
}
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let agent = null;
let quitting = false;
let restartDelay = 2000;
let status = null; // last status from the agent process
let info = null; // { backendUrl, signedIn, username, name, proxy }

// ------------------------------------------------------------------ runtime

function runtimeRoot() {
  const packaged = path.join(process.resourcesPath || '', 'runtime');
  if (app.isPackaged && fs.existsSync(path.join(packaged, 'dist', 'agent', 'main.js'))) return packaged;
  return path.resolve(__dirname, '..');
}

function nodeBinary(root) {
  if (process.env.HOELNI_NODE) return process.env.HOELNI_NODE;
  const bundled = path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  return fs.existsSync(bundled) ? bundled : 'node';
}

const dataDir = () => process.env.HOELNI_AGENT_DIR || app.getPath('userData');
const entry = () => path.join(runtimeRoot(), 'dist', 'agent', 'main.js');

function env(extra = {}) {
  const e = { ...process.env, HOELNI_AGENT_DIR: dataDir(), ...extra };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

/** Runs a one-shot agent command (login, logout, status, …) and returns its JSON answer. */
function cli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(nodeBinary(runtimeRoot()), [entry(), ...args, '--json'], { cwd: runtimeRoot(), env: env(extraEnv), windowsHide: true, timeout: 60_000 }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: err ? err.message : 'No answer from the agent' });
      }
    });
  });
}

async function refreshInfo() {
  info = await cli(['status']);
  send('info', info);
  return info;
}

// ------------------------------------------------------------------ updates
// The agent downloads and verifies updates itself (signed releases via the backend) and exits with
// code 75 when it is a good moment. The staged files are installed here while it is NOT running;
// if the new version does not keep running for 2 minutes, the previous one is restored.

const RESTART_FOR_UPDATE = 75;
const PROBATION_MS = 120_000;
let probation = null; // { until, timer } after an installed update

function updateCmd(args) {
  const script = path.join(runtimeRoot(), 'dist', 'agent', 'update.js');
  if (!fs.existsSync(script)) return null;
  try {
    const outText = execFileSync(nodeBinary(runtimeRoot()), [script, ...args], { cwd: runtimeRoot(), env: env(), windowsHide: true, timeout: 10 * 60_000 }).toString();
    const r = JSON.parse(outText.trim().split('\n').pop());
    for (const l of r.log ?? []) log(`update: ${l}`);
    return r;
  } catch (e) {
    log(`update ${args[0]} failed: ${e.message}`);
    return null;
  }
}

function log(line) {
  try {
    const dir = path.join(dataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'agent.log'), `${new Date().toISOString()} [app] ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** Fingerprint of the window program files that are running now (see loader.cjs). */
function shellFingerprint() {
  const dir = path.join(runtimeRoot(), 'agent-app');
  try {
    const h = require('node:crypto').createHash('sha256');
    for (const f of fs.readdirSync(dir).filter((x) => /\.(cjs|js|html)$/.test(x)).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
    return h.digest('hex');
  } catch {
    return '';
  }
}
const startedShell = app.isPackaged ? shellFingerprint() : '';

/** Keeps watching an update that was applied just before a restart of this app (rollback if it fails). */
function resumeProbation() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(runtimeRoot(), '.update', 'applied.json'), 'utf8'));
    const age = Date.now() - Date.parse(a.at);
    if (a.stable || !(age >= 0 && age < PROBATION_MS)) return;
    const timer = setTimeout(() => {
      probation = null;
      updateCmd(['stable']);
    }, PROBATION_MS - age);
    probation = { until: Date.now() + PROBATION_MS - age, timer };
  } catch {
    /* no update applied */
  }
}

/** Installs a staged update (before the agent starts). */
function installPendingUpdate() {
  const r = updateCmd(['apply']);
  if (!r?.applied) return;
  if (app.isPackaged && shellFingerprint() !== startedShell) {
    // The update brings a new agent window/tray: restart the program so it takes effect now.
    log(`update ${r.build}: new window program – restarting the agent app`);
    quitting = true;
    app.relaunch({ args: ['--hidden'] });
    app.exit(0);
    return;
  }
  clearTimeout(probation?.timer);
  const timer = setTimeout(() => {
    probation = null;
    updateCmd(['stable']);
  }, PROBATION_MS);
  probation = { until: Date.now() + PROBATION_MS, timer };
  notify('Aktualisiert', `Update installiert (Build ${r.build}).`);
}

function startAgent() {
  if (agent || quitting || !info?.signedIn) return;
  installPendingUpdate();
  const logDir = path.join(dataDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'agent.log'), 'a');
  agent = spawn(nodeBinary(runtimeRoot()), [entry(), 'run', '--json'], { cwd: runtimeRoot(), env: env(), stdio: ['ignore', out, out, 'ipc'], windowsHide: true });
  agent.on('message', (m) => {
    if (m?.type !== 'status') return;
    const before = status;
    status = m.status;
    restartDelay = 2000;
    send('status', status);
    updateTray();
    if (status.state === 'revoked' && before?.state !== 'revoked') notify('Abgemeldet', 'Der Zugang dieses PCs wurde beendet – bitte neu anmelden.');
  });
  agent.on('exit', (code) => {
    agent = null;
    if (quitting) return;
    if (code === RESTART_FOR_UPDATE) {
      restartDelay = 2000;
      setTimeout(startAgent, 500); // installs the staged update first
      return;
    }
    if (probation && Date.now() < probation.until && code !== 0 && code !== 3) {
      // The new version stopped right after the update: back to the previous one.
      clearTimeout(probation.timer);
      probation = null;
      const r = updateCmd(['rollback', `exit code ${code} right after the update`]);
      if (r?.rolledBack) notify('Update zurückgenommen', 'Die neue Version lief nicht – die vorherige ist wieder aktiv.');
    }
    if (code === 3) {
      // not signed in (anymore)
      status = null;
      void refreshInfo().then(() => { updateTray(); showWindow(); });
      return;
    }
    setTimeout(startAgent, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60_000);
  });
}

function stopAgent() {
  return new Promise((resolve) => {
    if (!agent) return resolve();
    const a = agent;
    a.once('exit', () => resolve());
    try {
      a.send({ cmd: 'stop' });
    } catch {
      a.kill();
    }
    setTimeout(() => a.kill(), 5000);
  });
}

// ------------------------------------------------------------------ window + tray

function icon(name) {
  const p = path.join(__dirname, 'build', name);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title: `Hoelni Agent – ${title}`, body }).show();
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 480,
    title: 'Hoelni Agent',
    icon: icon('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

const STATE_DE = { connecting: 'verbindet…', online: 'verbunden', offline: 'offline – versucht erneut', paused: 'pausiert', revoked: 'abgemeldet' };

function updateTray() {
  if (!tray) return;
  const st = status;
  const line = !info?.signedIn ? 'Nicht angemeldet' : st ? `${STATE_DE[st.state] ?? st.state}${st.sessions?.length ? ` · ${st.sessions.length} Session(s)` : ''}` : 'startet…';
  tray.setToolTip(`Hoelni Agent – ${line}`);
  const autostart = autostartOn();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Hoelni Agent – ${line}`, enabled: false },
      { type: 'separator' },
      { label: 'Fenster öffnen', click: showWindow },
      st && st.state !== 'paused' && st.state !== 'revoked' ? { label: 'Pausieren', click: () => agent?.send({ cmd: 'pause' }) } : null,
      st?.state === 'paused' ? { label: 'Fortsetzen', click: () => agent?.send({ cmd: 'resume' }) } : null,
      { type: 'separator' },
      { label: 'Mit Windows starten', type: 'checkbox', checked: autostart, click: (item) => { setAutostart(item.checked); updateTray(); send('autostart', autostartOn()); } },
      { label: 'Beenden', click: () => void quit() },
    ].filter(Boolean)),
  );
}

async function quit() {
  quitting = true;
  await stopAgent();
  app.quit();
}

// ------------------------------------------------------------------ IPC from the window

ipcMain.handle('info', async () => ({ info: await refreshInfo(), status, autostart: autostartOn(), version: app.getVersion() }));

ipcMain.handle('login', async (_e, { username, password, name, trustFingerprint }) => {
  const args = ['login', '--user', String(username || '')];
  if (name) args.push('--name', String(name));
  if (trustFingerprint) args.push('--trust-cert', String(trustFingerprint));
  // The password goes through the environment of the one-shot process, never the command line.
  const r = await cli(args, { HOELNI_AGENT_PASSWORD: String(password || '') });
  if (r.ok) {
    await refreshInfo();
    if (!autostartOn() && app.isPackaged) setAutostart(true);
    startAgent();
    updateTray();
  }
  return r;
});

ipcMain.handle('logout', async () => {
  await stopAgent();
  const r = await cli(['logout']);
  status = null;
  await refreshInfo();
  updateTray();
  return r;
});

ipcMain.handle('pause', () => {
  agent?.send({ cmd: 'pause' });
  return true;
});

ipcMain.handle('resume', () => {
  agent?.send({ cmd: 'resume' });
  return true;
});

ipcMain.handle('change-backend', async (_e, { url, adminUser, adminPassword }) => {
  const r = await cli(['change-backend', '--backend', String(url || ''), '--admin-user', String(adminUser || '')], { HOELNI_ADMIN_PASSWORD: String(adminPassword || '') });
  if (r.ok) {
    await stopAgent();
    status = null;
    await refreshInfo();
    updateTray();
  }
  return r;
});

ipcMain.handle('set-proxy', async (_e, { proxy }) => {
  const r = await cli(['set-proxy', String(proxy || '')]);
  if (r.ok && agent) {
    await stopAgent();
    startAgent();
  }
  await refreshInfo();
  return r;
});

ipcMain.handle('autostart', (_e, { on }) => {
  setAutostart(!!on);
  updateTray();
  return autostartOn();
});

// ------------------------------------------------------------------ lifecycle

app.on('second-instance', showWindow);
app.on('window-all-closed', () => undefined); // keep running in the tray
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(async () => {
  if (app.isPackaged) resumeProbation();
  app.setAppUserModelId('net.hoelni.agent');
  tray = new Tray(icon('tray.png'));
  tray.on('click', showWindow);
  await refreshInfo();
  updateTray();
  if (info?.signedIn) startAgent();
  if (!process.argv.includes('--hidden') || !info?.signedIn) showWindow();
});
