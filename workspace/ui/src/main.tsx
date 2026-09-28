import './app/state';
import './app/keymap';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { start } from './app/bootstrap';
import { installErrorLog } from '#ipc/log';
import { platform } from '#kernel/platform';
import { initTheme } from './ui/theme';

installErrorLog();
document.documentElement.dataset.platform = platform();
initTheme();
export const root = createRoot(document.getElementById('app')!);
root.render(<App />);

// vitest imports this module for its side effects and drives the app itself
if (!import.meta.env.VITEST) void start();
