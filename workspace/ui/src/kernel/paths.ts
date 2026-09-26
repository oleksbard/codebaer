/** Every place the frontend reads a platform path; the Windows port changes this file (platform doc, 5.2). */
export const HOME_ROOT = '/Users/';

/** The last segment of a path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** `path` is `dir` or inside it. */
export const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);
