let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.onclick = () => el.remove();
  ensureHost().appendChild(el);
  if (kind !== 'err') setTimeout(() => el.remove(), 6000);
}

export function confirmDialog(message: string): boolean {
  return globalThis.confirm(message);
}
