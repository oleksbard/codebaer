import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { blameShort, blameText, buildQueue, plural, split } from '#core/model';
import {
  closeFile, hasUnstaged, keepMine, reload, toggleChangesOnly, view, viewChanges,
} from '#core/session';
import { conflictIndexAtCursor, conflicts } from '#editor/conflicts';
import { chunkCount, chunkIndexAtCursor } from '#editor/editor';
import { CommentLayer, PendingPill } from '#features/comments';
import { git, type DiffStat as Stat } from '#ipc/git';
import { logError } from '#ipc/log';
import { keyLabel } from '#kernel/keymap';
import { run } from '#kernel/registry';
import { useApp } from '#kernel/store';
import { Button } from '#ui/Button';
import { Count } from '#ui/Count';
import { DiffStat } from '#ui/DiffStat';
import { FileIcon } from '#ui/FileIcon';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import { Pill } from '#ui/Pill';
import { acceptFile, nextHunk, rejectFile, unstageFile, unstageHunk } from './hunks';
import { ImageDiff } from './ImageDiff';
import { previews } from './images';
import { mainPane, mainSide, sideChosen } from './layout';

export const PANEL_TEXT: Record<string, string> = {
  Binary: 'binary file', NotUtf8: 'not UTF-8', TooLarge: 'over 2 MB', Special: 'not a regular file',
};
const NO_LINES: Stat = { added: 0, removed: 0 };
const SIDE_BY_SIDE = 'M2.5 3.5h11v9h-11zM8 3.5v9';

/** Settings owns the file the choice is saved in, and it imports this feature, so the button goes through its
 *  command. */
export function LayoutButton() {
  const s = useApp();
  return (
    <IconButton label="Side by side" aria-pressed={sideChosen(s)} onClick={() => run('settings.toggleDiffLayout')}>
      <StrokeIcon d={SIDE_BY_SIDE} size={14} />
    </IconButton>
  );
}

export function ReviewPane() {
  const s = useApp();
  const o = s.open;
  const showEditor = !!o && !o.panel;
  return (
    <main className="main">
      <TitleBar />
      <Banner />
      <EditorHost hidden={!showEditor} side={mainSide(s)} />
      <CommentLayer />
      {!showEditor && <Blank />}
    </main>
  );
}

function EditorHost({ hidden, side }: { hidden: boolean; side: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.appendChild(view.dom);
    return () => { view.dom.remove(); };
  }, []);
  useEffect(() => {
    const left = mainPane();
    if (side) ref.current!.prepend(left.dom);
    // side by side the host scrolls both editors, and unified the editor scrolls itself, so the cursor has to be
    // brought back into view in the new one
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
    return () => { left.dom.remove(); };
  }, [side]);
  return <div className={side ? 'editor-host split' : 'editor-host'} ref={ref} hidden={hidden} />;
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
    ? <span className="blame" title={blameText(s.blame)}>{blameShort(s.blame, Date.now())}</span>
    : null;
  // VS Code's dirty tab: a dot where the close button is, the button again under the pointer
  const close = o.dirty
    ? <IconButton label="Close file (unsaved changes)" className="close unsaved" onClick={() => void closeFile()}>
      <span className="dot" /><span className="x">✕</span></IconButton>
    : <IconButton label="Close file" className="close" onClick={() => void closeFile()}>✕</IconButton>;
  if (o.panel) {
    const image = previews(o.path, o.panel) && !o.conflicted;
    const changes = image && o.view === 'plain' && hasUnstaged(o.path)
      ? <Button onClick={() => void viewChanges(o.path)}>View changes</Button>
      : null;
    return <div className="tbar">{title}<span className="pos">{image ? 'image' : PANEL_TEXT[o.panel] ?? o.panel}</span>
      <div className="right"><PendingPill />{badge}{changes}{close}</div></div>;
  }
  if (o.conflicted) {
    const total = conflicts(view.state).length;
    const at = conflictIndexAtCursor(view.state);
    const pos = !total ? 'no conflict markers left'
      : at < 0 ? plural(total, 'conflict')
        : <>conflict <Count value={at + 1} /> of {total}</>;
    return (
      <div className="tbar">{title}<span className="pos">{pos}</span>{blame}
        <div className="right"><PendingPill />{badge}
          <Button variant="primary" onClick={() => void acceptFile(o.path)}>Mark resolved</Button>{close}</div>
      </div>
    );
  }
  const chunks = chunkCount(view.state);
  const at = chunkIndexAtCursor(view.state);
  const pos = o.view === 'plain' ? 'working tree'
    : chunks ? <>hunk <Count value={Math.max(at, 0) + 1} /> of {chunks}</>
      : o.view === 'staged' ? 'nothing staged' : 'no unstaged changes';
  const btns = o.view === 'unstaged' && chunks
    ? <><Button onClick={() => void rejectFile(o.path)}>
      Reject file <Kbd>{keyLabel('review.discardFile')}</Kbd></Button>
    <Button variant="primary" onClick={() => void acceptFile(o.path)}>
      Accept file <Kbd>{keyLabel('review.stageFile')}</Kbd></Button></>
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
      {o.view === 'unstaged' && <LayoutButton />}
    </>
  );
  return (
    <div className="tbar">{title}<span className="pos">{pos}</span>{blame}
      <div className="right"><PendingPill />{badge}{nav}{btns}{close}</div>
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
  if (previews(o.path, o.panel) && !o.conflicted) {
    return (
      <div className="image-pane">
        <ImageDiff path={o.path} view={o.view} tick={s.status} />
        {btns ? <p className="image-btns">{btns}</p> : null}
      </div>
    );
  }
  return (
    <div className="blank">
      <div>
        <h2>{text}</h2>
        {btns ? <><p>Whole-file actions only.</p><p>{btns}</p></> : null}
      </div>
    </div>
  );
}
