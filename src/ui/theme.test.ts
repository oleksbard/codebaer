import { beforeEach, describe, expect, it } from 'vitest';
import { getTheme, initTheme, setTheme, THEMES } from './theme';

beforeEach(() => {
  localStorage.removeItem('codebaer.theme');
  delete document.documentElement.dataset.theme;
});

describe('theme switch', () => {
  it('ships one theme and reads dark when no attribute is set', () => {
    expect(THEMES).toEqual(['dark']);
    expect(getTheme()).toBe('dark');
  });

  it('setTheme writes the root attribute and localStorage', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('codebaer.theme')).toBe('dark');
  });

  it('initTheme applies a stored value and ignores an unknown one', () => {
    localStorage.setItem('codebaer.theme', 'dark');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');

    delete document.documentElement.dataset.theme;
    localStorage.setItem('codebaer.theme', 'solarized');
    initTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
