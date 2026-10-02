import { TIP_DELAY } from './Tip';

const GAP = 6;
const PAD = 8;

/** The tip for an element React does not render (CodeMirror's widgets), in the same markup `Tip` draws. It lives in
 *  `document.body` only while it shows; the listeners that dismiss it are on the window only for that long. */
export function attachTip(el: HTMLElement, label: string): void {
  let tip: HTMLElement | null = null;
  let timer = 0;

  const hide = (): void => {
    clearTimeout(timer);
    window.removeEventListener('keydown', hide, true);
    window.removeEventListener('scroll', hide, true);
    window.removeEventListener('pointermove', orphaned, true);
    tip?.remove();
    tip = null;
  };

  function orphaned(): void {
    if (!el.isConnected) hide();
  }

  const show = (): void => {
    if (tip || !el.isConnected) return;
    const node = document.createElement('div');
    node.className = 'tip tip-s';
    node.setAttribute('role', 'tooltip');
    node.dataset.state = 'delayed-open';
    const line = document.createElement('span');
    line.className = 'tip-line';
    const text = document.createElement('span');
    text.className = 'tip-label';
    text.textContent = label;
    line.append(text);
    node.append(line);
    node.style.position = 'fixed';
    document.body.append(node);
    const at = el.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const below = at.bottom + GAP;
    const top = below + h > window.innerHeight - PAD && at.top - GAP - h >= PAD ? at.top - GAP - h : below;
    const left = Math.max(PAD, Math.min(at.left + at.width / 2 - w / 2, window.innerWidth - w - PAD));
    node.style.top = `${top}px`;
    node.style.left = `${left}px`;
    tip = node;
    window.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointermove', orphaned, true);
  };

  el.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    timer = window.setTimeout(show, TIP_DELAY.open);
  });
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown', hide);
}
