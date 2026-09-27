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

async function ensureBackend() {
  if (await backendUp()) return; // e.g. started by the autostart task – just attach
  startBackend();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await backendUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  let tail = '';
  try {
    tail = fs.readFileSync(logFile(), 'utf8').split('\n').slice(-15).join('\n');
  } catch {}
  throw new Error(`The suite did not start within 90 s.\n\n${tail}`);
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
  win.loadURL(`${BASE}/`);
  // Everything outside the suite (Discord verification links, webmail, OAuth) opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
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
      new Notification({ title: 'Hoelni Client Suite', body: 'Still running in the tray – your AFK sessions stay online.' }).show();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Hoelni Client Suite');
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open Hoelni Client Suite', click: showWindow },
      { type: 'separator' },
      {
        label: 'Start with Windows (in the tray)',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: 'Quit (sessions go offline)', click: () => quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.setContextMenu(menu()));
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
  createTray();
  try {
    await ensureBackend();
  } catch (e) {
    dialog.showErrorBox('Hoelni Client Suite could not start', String(e.message || e));
    quitting = true;
    app.exit(1);
    return;
  }
  createWindow();
});
