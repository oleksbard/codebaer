import './app/state';
import './app/keymap';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { start } from './app/bootstrap';
import { installErrorLog } from '#ipc/log';
import { initTheme } from './ui/theme';

installErrorLog();
initTheme();
createRoot(document.getElementById('app')!).render(<App />);

// vitest imports this module for its side effects and drives the app itself
if (!import.meta.env.VITEST) void start();
