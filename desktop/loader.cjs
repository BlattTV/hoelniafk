/**
 * Entry point of the installed program. Starts the newest window program: the one that came with
 * the latest update (resources/backend/desktop/main.cjs, replaced by every suite update), otherwise
 * the one from the installer. So the window, tray and game-window handling update themselves –
 * a new installer is only needed for a new Electron version.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const updated = path.join(process.resourcesPath || '', 'backend', 'desktop', 'main.cjs');
let started = false;
if (app.isPackaged && process.env.HOELNI_BUILTIN_SHELL !== '1' && fs.existsSync(updated)) {
  try {
    require(updated);
    started = true;
  } catch (e) {
    console.error(`Updated window program could not be loaded – using the installed one: ${e && e.message}`);
  }
}
if (!started) require('./main.cjs');
