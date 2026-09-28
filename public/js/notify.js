/**
 * Desktop notifications for things that need you: a session got blocked, a link code
 * arrived, an update is ready. Works in the desktop program (and in browsers after permission).
 * Switched on/off in Settings; the choice is stored per PC.
 */
const KEY = 'hoelni-notify';
const lastState = new Map();
let updateShown = null;

export function notificationsEnabled() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export async function setNotifications(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
}

function show(title, body, hash) {
  if (!notificationsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: `${title}:${body}`.slice(0, 120), silent: false });
  n.onclick = () => {
    window.focus();
    if (hash) location.hash = hash;
  };
}

export function handleEvent(ev) {
  if (ev.type === 'session.state' && ev.data) {
    const s = ev.data;
    const prev = lastState.get(s.id);
    lastState.set(s.id, s.state);
    if (prev && prev !== s.state && s.state === 'BLOCKED') show(`Session blocked – ${s.serverName}`, s.lastError ?? 'Automatic reconnect stopped', `#/identity/${s.identityId}/sessions`);
    if (prev === 'ONLINE' && s.state === 'RECONNECTING' && s.lastError) show(`Disconnected – ${s.serverName}`, s.lastError, `#/identity/${s.identityId}/sessions`);
  }
  if (ev.type === 'link.state' && ev.data?.hasCode) show('Link code received', 'A Minecraft server sent a Discord link code', `#/identity/${ev.identityId}/discord`);
  if (ev.type === 'updates.status' && ev.data?.available && ev.data.latest && updateShown !== ev.data.latest.build) {
    updateShown = ev.data.latest.build;
    show('Update ready', `Hoelni ${ev.data.latest.version} can be installed`, '#/settings');
  }
}

export function primeStates(sessions) {
  for (const s of sessions) lastState.set(s.id, s.state);
}
