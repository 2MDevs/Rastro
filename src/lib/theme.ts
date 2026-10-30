export type Theme = 'dark' | 'light';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#F4F2EA' : '#1D1D1B');
  try { localStorage.setItem('rastro-tema', t); } catch { /* navegador sem armazenamento */ }
  window.dispatchEvent(new CustomEvent('rastro-tema', { detail: t }));
}
