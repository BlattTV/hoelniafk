// Applied before the page renders (no flash): the user's light/dark choice, else the system setting.
try {
  const t = localStorage.getItem('hoelni-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage unavailable */
}
