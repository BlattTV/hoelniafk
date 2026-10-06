// Applied before the page renders (no flash): the user's light/dark choice, otherwise the system's.
try {
  const t = localStorage.getItem('hoelni-theme');
  const apply = () => {
    document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  apply();
  if (t !== 'light' && t !== 'dark') window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
} catch {
  /* storage unavailable */
}
