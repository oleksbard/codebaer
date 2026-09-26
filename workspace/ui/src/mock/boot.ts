// The entry of mock.html: the real app on an in-memory backend. vite build bundles only index.html, so
// nothing under src/mock ships.
import { mockIPC } from '@tauri-apps/api/mocks';
import { createBackend, type MenuItem } from './backend';
import { SCENARIOS } from './scenarios';

const params = new URLSearchParams(location.search);
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
try { localStorage.removeItem('codebaer.lastRepo'); } catch { /* storage blocked: nothing to forget */ }

// the accelerators the native menu owns, which a browser tab has no menu bar for
const ACCELERATORS: Record<string, MenuItem> = { Comma: 'settings', KeyO: 'open-folder' };
globalThis.addEventListener('keydown', (e) => {
  const item = ACCELERATORS[e.code];
  if (!item || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
  e.preventDefault();
  void backend.api.menu(item);
});

await import('#main');
