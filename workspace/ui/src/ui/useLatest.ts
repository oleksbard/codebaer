import { useRef } from 'react';

/** Keeps the last non-null value it was given. A registered overlay's own store field is already null while
 *  its `Presence` exit plays, and it still needs the data it was showing to render through that. */
export function useLatest<T>(value: T | null): T | null {
  const ref = useRef(value);
  if (value !== null) ref.current = value;
  return ref.current;
}
