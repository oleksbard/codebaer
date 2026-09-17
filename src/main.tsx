import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { start } from './app/controller';
import { initTheme } from './ui/theme';

initTheme();
createRoot(document.getElementById('app')!).render(<App />);

// vitest imports this module for its side effects and drives the controller itself
if (!import.meta.env.VITEST) void start();
