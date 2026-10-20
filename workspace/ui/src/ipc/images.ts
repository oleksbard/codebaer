import { git, type Rev } from './git';

/** What the webview can draw. SVG is text, so it opens in the editor. */
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
};

export function imageType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** `url` is empty for an empty file. */
export type Picture = { url: string; bytes: number };

/** A data: URL, which the CSP lets an img load. */
export const readPicture = async (rev: Rev | null, path: string): Promise<Picture> =>
  toPicture(await git.readImage(rev, path), path);

/** `path` names the type. */
export async function toPicture(buf: ArrayBuffer, path: string): Promise<Picture> {
  if (!buf.byteLength) return { url: '', bytes: 0 };
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('could not read the image'));
    r.readAsDataURL(new Blob([buf], { type: imageType(path) ?? 'application/octet-stream' }));
  });
  return { url, bytes: buf.byteLength };
}
