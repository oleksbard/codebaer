export type Platform = 'macos' | 'linux' | 'windows';

/** macOS until the Linux port asks the backend (docs/2026-09-25-linux-windows-support-design.md, rule 4). */
export const platform = (): Platform => 'macos';
