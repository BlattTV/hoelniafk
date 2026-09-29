/**
 * UI language (English / Deutsch).
 *
 * Every text the UI renders goes through the element helper in ui.js and t() here: exact texts are looked up in
 * the dictionary, texts with numbers/names are matched against templates like
 * "{0} selected" → "{0} ausgewählt". Unknown texts (chat lines, mail subjects, names) stay as they are.
 * The language is stored in the suite (so the tray menu follows it) and cached in localStorage
 * so the first paint is already in the right language.
 */
import DE from './i18n-de.js';

const KEY = 'hoelni.lang';
export const LANGUAGES = [['en', 'English'], ['de', 'Deutsch']];

export const lang = (() => {
  try {
    return localStorage.getItem(KEY) === 'de' ? 'de' : 'en';
  } catch {
    return 'en';
  }
})();

const exact = new Map(Object.entries(DE));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = [...exact]
  .filter(([k]) => /\{\d\}/.test(k))
  .map(([k, v]) => {
    const parts = k.split(/\{\d\}/);
    return {
      prefix: parts[0],
      suffix: parts[parts.length - 1],
      re: new RegExp(`^${parts.map(esc).join('([\\s\\S]*?)')}$`),
      order: [...k.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1])),
      v,
    };
  })
  // most specific (longest literal text) first
  .sort((a, b) => b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length));

const cache = new Map();

/**
 * Single words are not translated where data is shown (table cells, bold names, code): a server called
 * "Test" or an identity called "Mail" must stay as it is. Texts with spaces or placeholders are
 * distinctive enough to translate anywhere.
 */
const DATA_TAGS = new Set(['TD', 'STRONG', 'CODE', 'PRE', 'TEXTAREA']);

export function t(s, tag) {
  if (lang !== 'de' || typeof s !== 'string' || !s) return s;
  if (tag && DATA_TAGS.has(tag) && !/\s/.test(s.trim())) return s;
  const hit = exact.get(s) ?? cache.get(s);
  if (hit !== undefined) return hit;
  let out = s;
  for (const p of templates) {
    if (!s.startsWith(p.prefix) || !s.endsWith(p.suffix)) continue;
    const m = p.re.exec(s);
    if (!m) continue;
    out = p.v.replace(/\{(\d)\}/g, (_, n) => m[p.order.indexOf(Number(n)) + 1] ?? '');
    break;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(s, out);
  return out;
}

/** Remembers the language locally (the suite setting is saved by the caller) and reloads the UI. */
export function setLanguage(next) {
  window.__hoelniLeaving = true; // requests cut off by the reload are not errors
  try {
    localStorage.setItem(KEY, next === 'de' ? 'de' : 'en');
  } catch {
    /* private mode – server setting still applies after reload */
  }
  location.reload();
}

/** Applies the server-side setting (e.g. chosen on another window); reloads once if it differs. */
export function syncLanguage(serverLang) {
  const want = serverLang === 'de' ? 'de' : 'en';
  if (want !== lang) setLanguage(want);
}

/** Translates the static HTML shell (sidebar) once. */
export function translateStatic(root = document.body) {
  if (lang !== 'de') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tr = t(trimmed);
    if (tr !== trimmed) n.nodeValue = raw.replace(trimmed, tr);
  }
  for (const el of root.querySelectorAll('[title]')) el.title = t(el.title);
  document.documentElement.lang = 'de';
}

// Browser dialogs (confirm/alert/prompt) get the same translation.
if (lang === 'de') {
  const wrap = (fn) => (msg, ...rest) => fn.call(window, t(String(msg ?? '')), ...rest);
  window.confirm = wrap(window.confirm);
  window.alert = wrap(window.alert);
  window.__hoelniT = t;
  window.prompt = wrap(window.prompt);
}
