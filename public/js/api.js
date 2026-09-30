const token = document.querySelector('meta[name="hoelni-token"]').content;

export class ApiError extends Error {
  constructor(message, status, type) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

/** Errors the user does not need to see (page is reloading, suite is restarting). */
const silentError = (message) => Object.assign(new ApiError(message, 0, 'Restarting'), { silent: true });

// Requests that are cut off because the page reloads (language switch, restart) are not errors.
const leaving = () => !!window.__hoelniLeaving;
addEventListener('beforeunload', () => (window.__hoelniLeaving = true));
addEventListener('pagehide', () => (window.__hoelniLeaving = true));

let recovering = null;
let overlay = null;
function showOverlay(message) {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'restart-overlay';
  const wrap = document.createElement('div');
  const logo = document.createElement('img');
  logo.className = 'restart-logo logo-card';
  logo.src = '/static/img/logo-card.png';
  logo.alt = 'Hoelni';
  const box = document.createElement('div');
  box.className = 'restart-box';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  const text = document.createElement('div');
  text.textContent = message;
  box.append(spin, text);
  wrap.append(logo, box);
  overlay.append(wrap);
  document.body.append(overlay);
}

/**
 * The suite restarts (update, rollback, crash): wait until it answers again, then reload the page –
 * a new suite process has a new API token, so the old page could not talk to it anymore.
 *   expectRestart: an update/rollback was started – wait until the NEW process answers.
 *   otherwise: a short hiccup ends as soon as the suite answers again (no reload needed).
 */
export function recoverAfterRestart({ expectRestart = false, message = 'The suite is restarting – one moment…' } = {}) {
  if (recovering) return recovering;
  const shown = setTimeout(() => showOverlay(window.__hoelniT ? window.__hoelniT(message) : message), expectRestart ? 0 : 1500);
  recovering = (async () => {
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      let status = 0;
      try {
        status = (await fetch('/api/status', { headers: { 'x-hoelni-token': token }, cache: 'no-store' })).status;
      } catch {
        continue; // still down
      }
      if (status === 401) break; // a new suite process is running
      if (status === 200 && !expectRestart) {
        clearTimeout(shown);
        overlay?.remove();
        overlay = null;
        recovering = null;
        return;
      }
    }
    window.__hoelniLeaving = true;
    location.reload();
  })();
  return recovering;
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-hoelni-token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (leaving() || recovering) throw silentError('Reloading');
    void recoverAfterRestart();
    throw silentError('The suite is not reachable – reconnecting');
  }
  if (res.status === 401 && !leaving()) {
    void recoverAfterRestart();
    throw silentError('The suite was restarted – reloading');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data && data.type);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
  /** URL for downloads (GET only, token as query parameter). */
  downloadUrl: (url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
};

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Server-sent events; reconnects automatically. */
export function subscribe(onEvent, onState) {
  let es;
  const connect = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => onState(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      onState(false);
      es.close();
      if (leaving()) return;
      void recoverAfterRestart(); // reloads the page if the suite came back as a new process
      setTimeout(connect, 3000);
    };
  };
  connect();
}
