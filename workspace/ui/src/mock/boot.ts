// The entry of mock.html: the real app on an in-memory backend. vite build bundles only index.html, so
// nothing under src/mock ships.
import { mockIPC } from '@tauri-apps/api/mocks';
import { setMotion } from '#ui/motion';
import { createBackend, type MenuItem } from './backend';
import { SCENARIOS } from './scenarios';

const params = new URLSearchParams(location.search);
// before the app loads: the app, CodeMirror and xterm all read it once
const PLATFORMS: Record<string, string> = { linux: 'Linux x86_64', macos: 'MacIntel' };
const wanted = PLATFORMS[params.get('platform') ?? ''];
if (wanted) Object.defineProperty(navigator, 'platform', { value: wanted, configurable: true });
const name = params.get('scenario') ?? 'review';
const scenario = SCENARIOS[name];
if (!scenario) {
  document.body.textContent = `No scenario "${name}". Try one of: ${Object.keys(SCENARIOS).join(', ')}.`;
  throw new Error(`unknown scenario ${name}`);
}
const num = (key: string, fallback: number): number => {
  const v = Number(params.get(key) ?? fallback);
  return Number.isFinite(v) ? v : fallback;
};

const backend = createBackend(name, scenario(), {
  slow: num('slow', 800),
  latency: num('latency', 0),
  theme: params.get('theme'),
  onIdle: (idle) => document.documentElement.toggleAttribute('data-mock-idle', idle),
});
mockIPC((cmd, args) => backend.invoke(cmd, (args ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
globalThis.__mock = backend.api;

// a remembered repo would open instead of what the scenario's initial_repo says
try {
  localStorage.removeItem('codebaer.lastRepo');
  localStorage.removeItem('codebaer.lastRepoClosed');
} catch { /* storage blocked: nothing to forget */ }

// the accelerators the macOS menu owns, which a browser tab has no menu bar for; Linux has no menu, and the app's
// own keymap binds them there
const ACCELERATORS: Record<string, MenuItem> = { Comma: 'settings', KeyO: 'open-folder' };
const menuBar = !/Linux|Win/.test(navigator.platform);
globalThis.addEventListener('keydown', (e) => {
  const item = ACCELERATORS[e.code];
  if (!menuBar || !item || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
  e.preventDefault();
  void backend.api.menu(item);
});

if (params.get('motion') === 'off') setMotion('off');

await import('#main');
