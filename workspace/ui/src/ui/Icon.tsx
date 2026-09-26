export function StrokeIcon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const REFRESH = 'M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v2.75H10.5';
export const CLOSE = 'M4 4l8 8M12 4l-8 8';
export const CHECK = 'M3.5 8.5l3 3 6-7';
