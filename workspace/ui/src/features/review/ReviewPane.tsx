import { useEffect, useRef, useState } from 'react';
import { buildQueue, plural, split } from '#core/model';
import {
  closeFile, hasUnstaged, keepMine, reload, toggleChangesOnly, view, viewChanges,
} from '#core/session';
import { chunkCount, chunkIndexAtCursor } from '#editor/editor';
import { CommentLayer, PendingPill } from '#features/comments';
import { git, type DiffStat as Stat } from '#ipc/git';
import { logError } from '#ipc/log';
import { keyLabel } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { Button } from '#ui/Button';
import { DiffStat } from '#ui/DiffStat';
import { FileIcon } from '#ui/FileIcon';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import { Pill } from '#ui/Pill';
import { accept, acceptFile, nextHunk, reject, rejectFile, unstageFile, unstageHunk } from './hunks';

export const PANEL_TEXT: Record<string, string> = {
  Binary: 'binary file', NotUtf8: 'not UTF-8', TooLarge: 'over 2 MB', Special: 'not a regular file',
};
const NO_LINES: Stat = { added: 0, removed: 0 };

export function ReviewPane() {
  const s = useApp();
  const o = s.open;
  const showEditor = !!o && !o.panel;
  return (
    <main className="main">
      <TitleBar />
      <Banner />
      <EditorHost hidden={!showEditor} />
      <CommentLayer />
      {!showEditor && <Blank />}
    </main>
  );
}

function EditorHost({ hidden }: { hidden: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.appendChild(view.dom);
    return () => { view.dom.remove(); };
  }, []);
  return <div className="editor-host" ref={ref} hidden={hidden} />;
}

function WholeFileButtons({ path, kind }: { path: string; kind: 'unstaged' | 'staged' }) {
  if (kind === 'unstaged') {
    return <>
      <Button onClick={() => void rejectFile(path)}>Reject file</Button>{' '}
      <Button variant="primary" onClick={() => void acceptFile(path)}>Accept file</Button>
    </>;
  }
  return <Button onClick={() => void unstageFile(path)}>Unstage file</Button>;
}

function TitleBar() {
  const s = useApp();
  const o = s.open;
  if (!o) return <div className="tbar"><div className="right"><PendingPill /></div></div>;
  const [dir, name] = split(o.path);
  const title = <span className="file"><FileIcon name={name} />
    <span className="txt"><span className="dir">{dir}</span>{name}</span></span>;
  const badge = o.badge
    ? <Pill tone="warn">changed on disk
      <button type="button" onClick={() => void reload()}>Reload</button>
      <button type="button" onClick={() => keepMine()}>Keep mine</button></Pill>
    : null;
  const blame = s.blame
    ? <span className="blame" title="Last commit to touch the line under the cursor">{s.blame}</span>
    : null;
  // VS Code's dirty tab: a dot where the close button is, the button again under the pointer
  const close = o.dirty
    ? <IconButton label="Close file (unsaved changes)" className="close unsaved" onClick={() => void closeFile()}>
      <span className="dot" /><span className="x">✕</span></IconButton>
    : <IconButton label="Close file" className="close" onClick={() => void closeFile()}>✕</IconButton>;
  if (o.panel) {
    return <div className="tbar">{title}<span className="pos">{PANEL_TEXT[o.panel] ?? o.panel}</span>
      <div className="right"><PendingPill />{badge}{close}</div></div>;
  }
  if (o.conflicted) {
    return (
      <div className="tbar">{title}<span className="pos">conflict</span>{blame}
        <div className="right"><PendingPill />{badge}
          <Button variant="primary" onClick={() => void acceptFile(o.path)}>Mark resolved</Button>{close}</div>
      </div>
    );
  }
  const chunks = chunkCount(view.state);
  const at = chunkIndexAtCursor(view.state);
  const pos = o.view === 'plain' ? 'working tree'
    : chunks ? `hunk ${Math.max(at, 0) + 1} of ${chunks}`
      : o.view === 'staged' ? 'nothing staged' : 'no unstaged changes';
  const mode = o.view === 'plain' ? 'whole file, current state'
    : o.view === 'staged' ? 'HEAD → index · read only' : 'index → working tree';
  const btns = o.view === 'unstaged' && chunks
    ? <><Button onClick={() => void reject()}>Reject <Kbd>{keyLabel('review.reject')}</Kbd></Button>
      <Button variant="primary" onClick={() => void accept()}>Accept <Kbd>{keyLabel('review.accept')}</Kbd></Button></>
    : o.view === 'staged' && chunks
      ? <Button onClick={() => void unstageHunk()}>Unstage <Kbd>{keyLabel('review.unstageHunk')}</Kbd></Button>
      : o.view === 'plain' && hasUnstaged(o.path)
        ? <Button onClick={() => void viewChanges(o.path)}>View changes</Button>
        : null;
  const nav = o.view === 'plain' || !chunks ? null : (
    <>
      <IconButton label={`Previous change (${keyLabel('review.prevHunk', 'last')})`}
        onClick={() => nextHunk(-1)}>↑</IconButton>
      <IconButton label={`Next change (${keyLabel('review.nextHunk', 'last')})`}
        onClick={() => nextHunk(1)}>↓</IconButton>
      <IconButton label="Show changes only" aria-pressed={s.changesOnly}
        onClick={() => toggleChangesOnly()}>⊟</IconButton>
    </>
  );
  return (
    <div className="tbar">{title}<span className="pos">{pos}</span>{blame}
      <div className="right"><PendingPill />{badge}{nav}<span className="mode">{mode}</span>{btns}{close}</div>
    </div>
  );
}

function Banner() {
  const s = useApp();
  const o = s.open;
  if (!o || o.panel) return null;
  if (o.conflicted) return <div className="banner conflict">Resolve the markers, then stage the file.</div>;
  if (o.view === 'plain') return null;
  const chunks = chunkCount(view.state);
  const changed = s.status?.files.some((f) => f.path === o.path
    && (o.view === 'staged' ? f.indexStatus !== '.' : f.worktreeStatus !== '.' || f.untracked));
  if (chunks !== 0 || !changed) return null;
  return <div className="banner">line endings, filters, or file mode only.{' '}
    <WholeFileButtons path={o.path} kind={o.view} /></div>;
}

/** Fetched again for every new status, which is every refresh. */
export function useDiffStat(status: object | null): Stat | null {
  const [stat, setStat] = useState<Stat | null>(null);
  useEffect(() => {
    if (!status) return;
    let live = true;
    git.diffStat().then((next) => { if (live) setStat(next); }, (e: unknown) => {
      logError(e, 'diff_stat');
      if (live) setStat(NO_LINES);
    });
    return () => { live = false; };
  }, [status]);
  return stat;
}

/** Waits for the line count, so the pill does not grow when it arrives. */
function QueueStat({ files }: { files: number }) {
  const s = useApp();
  const stat = useDiffStat(s.status);
  return (
    <div className="queue-stat">
      {stat ? <DiffStat added={stat.added} removed={stat.removed}
        files={{ n: files, label: `${plural(files, 'file')} to review` }} /> : null}
    </div>
  );
}

function Blank() {
  const s = useApp();
  const o = s.open;
  if (!o) {
    const n = s.status ? buildQueue(s.status).unstaged.length : 0;
    return (
      <div className="blank">
        <div>
          <img src="/logo.png" alt="" />
          {n ? <QueueStat files={n} /> : <>
            <h2>Nothing left to review</h2>
            <p>Write a message and commit with <Kbd>{keyLabel('git.commit')}</Kbd>, or wait for the agent.</p>
          </>}
        </div>
      </div>
    );
  }
  const text = PANEL_TEXT[o.panel!] ?? o.panel;
  // git refuses revert_path and stage_content on an unmerged path, so a conflicted
  // record gets the panel text and nothing to press
  const btns = o.conflicted || o.view === 'plain' ? null : <WholeFileButtons path={o.path} kind={o.view} />;
  return (
    <div className="blank">
      <div>
        <h2>{text}</h2>
        {btns ? <><p>Whole-file actions only.</p><p>{btns}</p></> : null}
      </div>
    </div>
  );
}
