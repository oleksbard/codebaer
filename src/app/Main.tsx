import { useEffect, useRef } from 'react';
import { chunkCount, chunkIndexAtCursor } from '../editor';
import { buildQueue, split } from '../model';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { IconButton } from '../ui/IconButton';
import { Pill } from '../ui/Pill';
import { accept, acceptFile, hasUnstaged, keepMine, nextHunk, reject, rejectFile, reload, toggleChangesOnly, unstageFile, unstageHunk, view, viewChanges } from './controller';
import { S, useApp } from './store';

const PANEL_TEXT: Record<string, string> = {
  Binary: 'binary file', NotUtf8: 'not UTF-8', TooLarge: 'over 2 MB', Special: 'not a regular file',
};

export function Main() {
  useApp();
  const o = S.open;
  const showEditor = !!o && !o.panel;
  return (
    <main className="main">
      <TitleBar />
      <Banner />
      <EditorHost hidden={!showEditor} />
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
    return <><Button onClick={() => void rejectFile(path)}>Reject file</Button> <Button variant="primary" onClick={() => void acceptFile(path)}>Accept file</Button></>;
  }
  return <Button onClick={() => void unstageFile(path)}>Unstage file</Button>;
}

function TitleBar() {
  useApp();
  const o = S.open;
  if (!o) return <div className="tbar" />;
  const [dir, name] = split(o.path);
  const title = <span className="file"><span className="dir">{dir}</span>{name}</span>;
  const badge = o.badge
    ? <Pill tone="warn">changed on disk<button type="button" onClick={() => void reload()}>Reload</button><button type="button" onClick={() => keepMine()}>Keep mine</button></Pill>
    : null;
  if (o.panel) {
    return <div className="tbar">{title}<span className="pos">{PANEL_TEXT[o.panel] ?? o.panel}</span><div className="right">{badge}</div></div>;
  }
  if (o.conflicted) {
    return (
      <div className="tbar">{title}<span className="pos">conflict</span>
        <div className="right">{badge}<Button variant="primary" onClick={() => void acceptFile(o.path)}>Mark resolved</Button></div>
      </div>
    );
  }
  const chunks = chunkCount(view.state);
  const at = chunkIndexAtCursor(view.state);
  const pos = o.view === 'plain' ? 'working tree' : chunks ? `hunk ${Math.max(at, 0) + 1} of ${chunks}` : o.view === 'staged' ? 'nothing staged' : 'no unstaged changes';
  const pill = o.view === 'plain' ? 'whole file, current state' : o.view === 'staged' ? 'HEAD → index · read only' : 'index → working tree';
  const btns = o.view === 'unstaged' && chunks
    ? <><Button onClick={() => void reject()}>Reject <Kbd>⌘N</Kbd></Button><Button variant="primary" onClick={() => void accept()}>Accept <Kbd>⌘Y</Kbd></Button></>
    : o.view === 'staged' && chunks
      ? <Button onClick={() => void unstageHunk()}>Unstage <Kbd>⌘K ⌘N</Kbd></Button>
      : o.view === 'plain' && hasUnstaged(o.path)
        ? <Button onClick={() => void viewChanges(o.path)}>View changes</Button>
        : null;
  const nav = o.view === 'plain' || !chunks ? null : (
    <>
      <IconButton label="Previous change (⇧F7)" onClick={() => nextHunk(-1)}>↑</IconButton>
      <IconButton label="Next change (F7)" onClick={() => nextHunk(1)}>↓</IconButton>
      <IconButton label="Show changes only" aria-pressed={S.changesOnly} onClick={() => toggleChangesOnly()}>⊟</IconButton>
    </>
  );
  return (
    <div className="tbar">{title}<span className="pos">{pos}</span>
      <div className="right">{badge}{nav}<Pill>{pill}</Pill>{btns}</div>
    </div>
  );
}

function Banner() {
  useApp();
  const o = S.open;
  if (!o || o.panel) return null;
  if (o.conflicted) return <div className="banner conflict">Resolve the markers, then stage the file.</div>;
  if (o.view === 'plain') return null;
  const chunks = chunkCount(view.state);
  const changed = S.status?.files.some((f) => f.path === o.path && (o.view === 'staged' ? f.indexStatus !== '.' : f.worktreeStatus !== '.' || f.untracked));
  if (chunks !== 0 || !changed) return null;
  return <div className="banner">line endings, filters, or file mode only. <WholeFileButtons path={o.path} kind={o.view} /></div>;
}

function Blank() {
  useApp();
  const o = S.open;
  if (!o) {
    const n = S.status ? buildQueue(S.status).unstaged.length : 0;
    return (
      <div className="blank">
        <div>
          <img src="/logo.png" alt="" />
          <h2>{n ? `${n} files to review` : 'Nothing left to review'}</h2>
          <p>{n ? 'Pick a file on the left, or press ⌥F5 to start at the first hunk.' : 'Write a message and commit with ⌘↩, or wait for the agent.'}</p>
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
