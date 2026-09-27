const token = document.querySelector('meta[name="hoelni-token"]').content;

export class ApiError extends Error {
  constructor(message, status, type) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-hoelni-token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
      setTimeout(connect, 3000);
    };
  };
  connect();
}
