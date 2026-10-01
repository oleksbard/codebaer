import './app/state';
import './app/keymap';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { start } from './app/bootstrap';
import { installErrorLog } from '#ipc/log';
import { platform } from '#kernel/platform';
import { initGlow } from './ui/glow';
import { initMotion } from './ui/motion';
import { MotionRoot } from './ui/MotionRoot';
import { initTheme } from './ui/theme';

installErrorLog();
document.documentElement.dataset.platform = platform();
initMotion(platform());
initTheme();
initGlow();
export const root = createRoot(document.getElementById('app')!);
root.render(<MotionRoot><App /></MotionRoot>);

// vitest imports this module for its side effects and drives the app itself
if (!import.meta.env.VITEST) void start();
