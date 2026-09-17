export const THEMES = ['dark'] as const;
export type Theme = (typeof THEMES)[number];

const KEY = 'codebaer.theme';
const isTheme = (v: unknown): v is Theme => (THEMES as readonly string[]).includes(v as string);

export function getTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : 'dark';
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function initTheme(): void {
  const t = localStorage.getItem(KEY);
  if (isTheme(t)) document.documentElement.dataset.theme = t;
}
