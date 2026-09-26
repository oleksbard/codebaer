import { notify, S } from './store';

/** `hint` is a key chord, drawn as a keycap; `note` is a word about the item, drawn as text. */
export type Item<T> = {
  label: string; detail?: string | undefined; hint?: string | undefined; note?: string | undefined; value: T;
};

export function fuzzy(label: string, q: string): boolean {
  let i = 0;
  for (const c of label.toLowerCase()) if (c === q[i]) i++;
  return i === q.length;
}

let nextId = 1;

export function pick<T>(items: Item<T>[], placeholder: string): Promise<T | null> {
  S.palette?.resolve(null);
  return new Promise((resolve) => {
    S.palette = { id: nextId++, items, placeholder, resolve: (v) => resolve(v as T | null) };
    notify();
  });
}

export function closePalette(id: number, value: unknown): void {
  const req = S.palette;
  if (req?.id !== id) return;
  S.palette = null;
  notify();
  req.resolve(value);
}
