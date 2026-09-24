/** Each id has a `[data-theme]` block in `themes.css` or `themes/`, and a variant in the Rust `Theme` enum. */
export const THEMES = [
  { id: 'codebaer', label: 'CodeBär', dark: true },
  { id: 'github-dark', label: 'GitHub Dark', dark: true },
  { id: 'one-dark', label: 'One Dark', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', dark: true },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: true },
  { id: 'nord', label: 'Nord', dark: true },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', dark: true },
  { id: 'solarized-dark', label: 'Solarized Dark', dark: true },
  { id: 'ayu-mirage', label: 'Ayu Mirage', dark: true },
  { id: 'rose-pine', label: 'Rosé Pine', dark: true },
  { id: 'github-light', label: 'GitHub Light', dark: false },
  { id: 'one-light', label: 'One Light', dark: false },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', dark: false },
  { id: 'tokyo-night-day', label: 'Tokyo Night Day', dark: false },
  { id: 'gruvbox-light', label: 'Gruvbox Light', dark: false },
  { id: 'solarized-light', label: 'Solarized Light', dark: false },
  { id: 'ayu-light', label: 'Ayu Light', dark: false },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', dark: false },
] as const;
export type Theme = (typeof THEMES)[number]['id'];
export const DEFAULT_THEME: Theme = 'codebaer';

const KEY = 'codebaer.theme';
export const isTheme = (v: unknown): v is Theme => THEMES.some((t) => t.id === v);
export const isDark = (t: Theme): boolean => THEMES.find((x) => x.id === t)?.dark ?? true;

export function getTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : DEFAULT_THEME;
}

/** The settings file owns the choice; the copy in localStorage only lets the first paint use it. */
export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function initTheme(): void {
  const t = localStorage.getItem(KEY);
  if (isTheme(t)) document.documentElement.dataset.theme = t;
}
