import { useEffect, useRef, useState } from 'react';
import type { ViewKind } from '#editor/editor';
import { errKind, errText, type Rev } from '#ipc/git';
import { readPicture, readStamp, sizeText, stagesOf, zoomOf, type Picture } from './images';

/** `id` is the stamp the picture was read under; null, with no picture, when the file is not there. */
type Read = { id: string | null; picture: Picture | null } | { error: string };

const failed = (e: unknown): Read =>
  ({ error: errKind(e) === 'TooLarge' ? 'over 16 MB, too large to show' : errText(e) });

/** Takes the file's stamp whenever `tick` changes, which is every refresh, and reads the picture again only when
 *  the stamp moved: the agent may have redrawn it, but most refreshes are about other files. A read outlives the
 *  refresh that started it, or a burst of refreshes would keep a big picture from ever arriving. */
function usePicture(rev: Rev | null, path: string, tick: unknown): Read | undefined {
  const key = `${rev ?? 'work'}:${path}`;
  const [got, setGot] = useState<{ key: string; read: Read } | null>(null);
  const last = useRef(got);
  const pending = useRef<{ key: string; id: string | null } | null>(null);
  /** The key on screen; null once unmounted. */
  const shown = useRef<string | null>(null);
  useEffect(() => {
    shown.current = key;
    return () => { shown.current = null; };
  }, [key]);
  useEffect(() => {
    let live = true;
    const settle = (read: Read) => {
      if (shown.current !== key) return;
      last.current = { key, read };
      setGot(last.current);
    };
    void readStamp(rev, path).then(async (id) => {
      if (!live) return;
      const was = last.current;
      if (was?.key === key && 'id' in was.read && was.read.id === id) return;
      if (pending.current?.key === key && pending.current.id === id) return;
      const mine = { key, id };
      pending.current = mine;
      let read: Read;
      try {
        read = { id, picture: id === null ? null : await readPicture(rev, path) };
      } catch (e) {
        read = failed(e);
      }
      // a newer stamp, or another file, started its own read meanwhile
      if (pending.current !== mine) return;
      pending.current = null;
      settle(read);
    }, (e: unknown) => { if (live) settle(failed(e)); });
    return () => { live = false; };
  }, [key, rev, path, tick]);
  return got?.key === key ? got.read : undefined;
}

function Side({ label, rev, path, tick, none }: {
  label: string | null; rev: Rev | null; path: string; tick: unknown; none: string;
}) {
  const read = usePicture(rev, path, tick);
  const [drawn, setDrawn] = useState<{ url: string; w: number; h: number } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const pic = read && 'picture' in read ? read.picture : null;
  const shown = !!pic?.bytes && broken !== pic.url;
  const size = pic && drawn?.url === pic.url ? drawn : null;
  const zoom = size ? zoomOf(size.w, size.h) : 1;
  const body = !read ? null
    : 'error' in read ? <p className="img-none">{read.error}</p>
      : !pic ? <p className="img-none">{none}</p>
        : !pic.bytes ? <p className="img-none">empty file</p>
          : broken === pic.url ? <p className="img-none">cannot show this image</p>
            : <img src={pic.url} alt={label ?? path} draggable={false}
              className={zoom > 1 ? 'zoomed' : undefined}
              style={size && zoom > 1 ? { width: size.w * zoom, height: size.h * zoom } : undefined}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDrawn({ url: pic.url, w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => setBroken(pic.url)} />;
  const meta = pic && shown
    ? [size && `${size.w} × ${size.h}`, sizeText(pic.bytes), zoom > 1 && `shown at ${zoom}×`].filter(Boolean)
      .join(' · ')
    : null;
  return (
    <figure className="img-side" data-rev={rev ?? 'work'}>
      {label && <figcaption>{label}</figcaption>}
      <div className={shown ? 'img-box checker' : 'img-box'}>{body}</div>
      <div className="img-meta">{meta}</div>
    </figure>
  );
}

/** A file the editor cannot open as text: the working tree alone in the plain view, else its two stages. */
export function ImageDiff({ path, view, tick }: { path: string; view: ViewKind; tick: unknown }) {
  if (view === 'plain') {
    return <div className="img-diff"><Side label={null} rev={null} path={path} tick={tick} none="no file" /></div>;
  }
  const [before, after] = stagesOf(view);
  return (
    <div className="img-diff">
      <Side label="Before" rev={before} path={path} tick={tick} none="new file" />
      <Side label="After" rev={after} path={path} tick={tick} none="deleted" />
    </div>
  );
}
