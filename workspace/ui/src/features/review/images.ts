import type { ViewKind } from '#editor/editor';
import { git, type Rev } from '#ipc/git';

/** What the webview can draw. SVG is text, so it opens in the editor. */
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
};
/** The read errors the editor gives an image. */
const PREVIEWED = new Set(['Binary', 'NotUtf8', 'TooLarge']);

export function imageType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Whether a file that the editor could not open shows as an image instead. */
export const previews = (path: string, panel: string | null): boolean =>
  !!panel && PREVIEWED.has(panel) && imageType(path) !== null;

/** The two stages a view compares: the original, then the changed one. Null is the working tree. */
export const stagesOf = (view: ViewKind): [Rev, Rev | null] =>
  (view === 'staged' ? ['head', 'index'] : ['index', null]);

export const readStamp = (rev: Rev | null, path: string): Promise<string | null> => git.imageStamp(rev, path);

/** `url` is empty for an empty file. */
export type Picture = { url: string; bytes: number };

/** A data: URL, which the CSP lets an img load. */
export async function readPicture(rev: Rev | null, path: string): Promise<Picture> {
  const buf = await git.readImage(rev, path);
  if (!buf.byteLength) return { url: '', bytes: 0 };
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('could not read the image'));
    r.readAsDataURL(new Blob([buf], { type: imageType(path) ?? 'application/octet-stream' }));
  });
  return { url, bytes: buf.byteLength };
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** How much to enlarge a small image, so an icon is not a speck. Whole steps keep its pixels square. */
export const zoomOf = (w: number, h: number): number => Math.max(1, Math.floor(128 / Math.max(w, h, 1)));
