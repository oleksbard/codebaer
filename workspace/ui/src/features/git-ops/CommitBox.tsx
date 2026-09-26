import { useEffect, useRef } from 'react';
import { keyLabel, matches } from '#kernel/keymap';
import { refs, useApp } from '#kernel/store';
import { Button } from '#ui/Button';
import { REFRESH, StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import { Spinner } from '#ui/Spinner';
import { aiMessage, cancel, checkout, commit, network, setCommitMessage } from './git-ops';

const PULL = 'M8 2v8M4.75 6.75 8 10l3.25-3.25M2.75 13.5h10.5';
const PUSH = 'M8 10V3M4.75 6.25 8 3l3.25 3.25M2.75 13.5h10.5';

function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M6.5 1Q7.1 5.4 11.5 6.5Q7.1 7.6 6.5 12Q5.9 7.6 1.5 6.5Q5.9 5.4 6.5 1z" />
      <path d="M12.5 9.5Q12.8 11.7 15 12.2Q12.8 12.7 12.5 15Q12.2 12.7 10 12.2Q12.2 11.7 12.5 9.5z" />
    </svg>
  );
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function RemoteActions() {
  const s = useApp();
  const st = s.status;
  if (!st) return null;
  // git reports no ahead count without an upstream, and push is the thing that creates one,
  // so an untracked branch offers push rather than hiding it until it can be counted
  const push = st.upstream === null ? st.head !== null : st.ahead > 0 && st.behind === 0;
  return (
    <span className="remote">
      {st.upstream !== null &&
        <IconButton label="Fetch from remote" disabled={s.busy} onClick={() => void network('fetch')}>
          <StrokeIcon d={REFRESH} /></IconButton>}
      {st.behind > 0 &&
        <IconButton label={`Pull ${commits(st.behind)}`}
          disabled={s.busy} onClick={() => void network('pull')}><StrokeIcon d={PULL} /></IconButton>}
      {push &&
        <IconButton label={st.upstream === null ? 'Push and set upstream' : `Push ${commits(st.ahead)}`}
          disabled={s.busy} onClick={() => void network('push')}><StrokeIcon d={PUSH} /></IconButton>}
    </span>
  );
}

function BranchBar() {
  const s = useApp();
  const st = s.status;
  const branch = !st ? '…' : st.head === null ? 'no commits' : st.branch ?? st.head.slice(0, 8);
  const ab = !st ? null : st.upstream
    ? <span className="ab">
        <span className={st.ahead ? 'on' : ''}>↑{st.ahead}</span>
        <span className={st.behind ? 'on' : ''}>↓{st.behind}</span>
      </span>
    : <span>no upstream</span>;
  return (
    <div className="branch">
      <button type="button" className="co" title="Checkout to…" onClick={() => void checkout()}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4"
          aria-hidden="true">
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="5.5" r="1.5" />
          <path d="M4.5 5v6M11.5 7a3.5 3.5 0 0 1-3.5 3.5H4.5" />
        </svg>
        <span className="nm">{branch}</span>{ab}
      </button>
      {/* the remote actions are disabled while busy, so the spinner takes their place in the narrow row */}
      {s.busy
        ? <span className="busy"><Spinner />
            {s.cancellable && <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>}</span>
        : <RemoteActions />}
    </div>
  );
}

const AI_OFF = 'Turn on an AI provider in Settings to write commit messages';

export function CommitBox({ staged, hidden }: { staged: number; hidden: boolean }) {
  const s = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const message = s.commitMessage;
  const aiOn = s.settings['general.headless-ai-provider'] !== 'off';
  useEffect(() => {
    const el = ref.current;
    if (!el || hidden) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [message, hidden]);
  return (
    <div className="commit" hidden={hidden}>
      <BranchBar />
      <textarea id="commit-message" rows={1} placeholder="Commit message" aria-label="Commit message" value={message}
        ref={(el) => { ref.current = el; refs.commit = el; }}
        onChange={(e) => setCommitMessage(e.target.value)}
        onKeyDown={(e) => { if (matches(e, 'git.commit')) { e.preventDefault(); void commit(); } }} />
      <div className="bar">
        <span className="hint">{staged ? `${staged} file${staged > 1 ? 's' : ''} staged` : 'Nothing staged yet'}</span>
        <span className="r">
          {/* a disabled .ico takes no pointer events, so the reason sits on a wrapper that does */}
          <span className="ai-wrap" title={aiOn ? undefined : AI_OFF}>
            <IconButton id="ai-btn" label={aiOn ? 'Write the commit message with Claude' : AI_OFF} busy={s.aiBusy}
              disabled={!aiOn || staged === 0 || s.aiBusy} onClick={() => void aiMessage()}><Sparkle /></IconButton>
          </span>
          <Button variant="primary" id="commit-btn" busy={s.committing}
            disabled={staged === 0 || !message.trim() || s.committing} onClick={() => void commit()}>
            {s.committing ? <><Spinner />Committing…</> : <>Commit <Kbd>{keyLabel('git.commit')}</Kbd></>}
          </Button>
        </span>
      </div>
    </div>
  );
}
