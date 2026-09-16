export type Item<T> = { label: string; detail?: string; hint?: string; value: T };

function fuzzy(label: string, q: string): boolean {
  let i = 0;
  for (const c of label.toLowerCase()) if (c === q[i]) i++;
  return i === q.length;
}

let active: (() => void) | null = null;

export function pick<T>(items: Item<T>[], placeholder: string): Promise<T | null> {
  active?.();
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="pal" role="dialog"><input type="text" autocomplete="off" spellcheck="false"><ul></ul></div>`;
    const input = scrim.querySelector('input')!;
    const list = scrim.querySelector('ul')!;
    input.placeholder = placeholder;
    let shown: Item<T>[] = items;
    let sel = 0;

    const close = (v: T | null) => {
      active = null;
      scrim.remove();
      resolve(v);
    };
    active = () => close(null);

    const render = () => {
      const q = input.value.toLowerCase();
      shown = q ? items.filter((it) => fuzzy(it.label, q)) : items;
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length
        ? shown.map((it, i) => `<li class="${i === sel ? 'on' : ''}" data-i="${i}"><span>${esc(it.label)}${it.detail ? ` <span class="desc">${esc(it.detail)}</span>` : ''}</span>${it.hint ? `<span class="k">${esc(it.hint)}</span>` : ''}</li>`).join('')
        : '<li class="desc">No matching results</li>';
      list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
    };

    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); close(shown[sel]?.value ?? null); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
    list.onclick = (e) => {
      const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
      if (li) close(shown[Number(li.dataset.i)]?.value ?? null);
    };
    scrim.onclick = (e) => { if (e.target === scrim) close(null); };

    document.body.appendChild(scrim);
    render();
    input.focus();
  });
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
