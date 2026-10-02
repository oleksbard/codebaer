import { notify, S } from './store';

/** `hint` is a key chord, drawn as a keycap; `note` is a word about the item, drawn as text; `sub` is a line
 *  under the label, for what is too long to sit beside it. */
export type Item<T> = {
  label: string; detail?: string | undefined; hint?: string | undefined; note?: string | undefined;
  sub?: string | undefined; value: T;
};

/** Both lowercase: the palette lowers each label once, not on every keystroke. */
export function fuzzy(label: string, q: string): boolean {
  let i = 0;
  for (const c of label) if (c === q[i]) i++;
  return i === q.length;
}

let nextId = 1;

/** `wide` is for labels long enough to wrap, such as a stash's description. */
export function pick<T>(items: Item<T>[], placeholder: string, wide = false): Promise<T | null> {
  S.palette?.resolve(null);
  return new Promise((resolve) => {
    S.palette = { id: nextId++, items, placeholder, wide, resolve: (v) => resolve(v as T | null) };
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
