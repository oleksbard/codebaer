/** Icons drawn in more than one place: the activity bar's buttons, which Settings and the app menu draw too, and the
 *  ones the app menu shares with the Commands menu, the commit box and the terminal rail. */

export function ChangesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      aria-hidden="true">
      <circle cx="4.5" cy="3" r="1.75" />
      <circle cx="4.5" cy="13" r="1.75" />
      <circle cx="11.5" cy="3" r="1.75" />
      <path d="M4.5 4.75v6.5M11.5 4.75v1.25a3 3 0 0 1-3 3h-4" />
    </svg>
  );
}

export function FilesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.75h3L12.75 5v6.25a.75.75 0 0 1-.75.75H6.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75z" />
      <path d="M9.5 1.75V5h3.25" />
      <path d="M10 14.25H4.75A.75.75 0 0 1 4 13.5V4.5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 13.5 13.5" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M5.25 3.25v9.5L12.75 8z" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="4" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.5" strokeWidth="1.2" />
      <path d="M12.5 8h2M1.5 8h2M8 12.5v2M8 1.5v2M11.2 11.2l1.4 1.4M3.4 3.4l1.4 1.4M4.8 11.2l-1.4 1.4M12.6 3.4l-1.4 1.4"
        strokeWidth="2" />
    </svg>
  );
}

export function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M6.5 1Q7.1 5.4 11.5 6.5Q7.1 7.6 6.5 12Q5.9 7.6 1.5 6.5Q5.9 5.4 6.5 1z" />
      <path d="M12.5 9.5Q12.8 11.7 15 12.2Q12.8 12.7 12.5 15Q12.2 12.7 10 12.2Q12.2 11.7 12.5 9.5z" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M4.5 6.25 6.5 8l-2 1.75M8.25 9.75h3.25" />
    </svg>
  );
}
