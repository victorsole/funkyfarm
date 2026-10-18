// Light, dark or the device setting. The choice is a per-browser convenience, never farm data.
export type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'funkyfarm.theme';

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch { return 'system'; }
}

export function applyTheme(choice: ThemeChoice) {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}

export function saveTheme(choice: ThemeChoice) {
  applyTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* Browser storage is optional; the choice still applies to this page. */ }
}
