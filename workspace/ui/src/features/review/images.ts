import type { ViewKind } from '#editor/editor';
import { git, type Rev } from '#ipc/git';
import { imageType } from '#ipc/images';

/** The read errors the editor gives an image. */
const PREVIEWED = new Set(['Binary', 'NotUtf8', 'TooLarge']);

/** Whether a file that the editor could not open shows as an image instead. */
export const previews = (path: string, panel: string | null): boolean =>
  !!panel && PREVIEWED.has(panel) && imageType(path) !== null;

/** The two stages a view compares: the original, then the changed one. Null is the working tree. */
export const stagesOf = (view: ViewKind): [Rev, Rev | null] =>
  (view === 'staged' ? ['head', 'index'] : ['index', null]);

export const readStamp = (rev: Rev | null, path: string): Promise<string | null> => git.imageStamp(rev, path);

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** How much to enlarge a small image, so an icon is not a speck. Whole steps keep its pixels square. */
export const zoomOf = (w: number, h: number): number => Math.max(1, Math.floor(128 / Math.max(w, h, 1)));
