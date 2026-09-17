import { notify, S } from './app/store';

export type Item<T> = { label: string; detail?: string; hint?: string; value: T };

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
