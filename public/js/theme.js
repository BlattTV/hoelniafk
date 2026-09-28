// Applied before the page renders (no flash): the user's light/dark choice (dark is the default).
try {
  const t = localStorage.getItem('hoelni-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage unavailable */
}
