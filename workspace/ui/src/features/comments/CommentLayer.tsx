import { useEffect, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DropdownMenu } from 'radix-ui';
import { keyLabel, matches } from '#kernel/keymap';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import {
  cancelDraft, deleteComment, discardComments, draftCaret, draftFocus, editComment, editDraft, jumpToComment, saveDraft,
  sendComments, startComment,
} from './actions';
import { firstLine, location, sortComments, type Comment, type Draft } from './comments';
import { commentHost, hostsVersion, subscribeHosts } from './editor-comments';

/** Portals the chip, the draft box and the cards into the hosts the editor's widgets hand out. */
export function CommentLayer() {
  const s = useApp();
  useSyncExternalStore(subscribeHosts, hostsVersion, hostsVersion);
  // a box whose DOM went away while it had focus sees no blur, and would take focus back from
  // wherever the owner went when it next mounts
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.comment-box'))) draftFocus(null, false);
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  const out: ReactNode[] = [];
  const chip = commentHost('chip');
  if (chip && !s.draft) out.push(createPortal(<Chip />, chip, 'chip'));
  const box = commentHost('draft');
  if (box && s.draft) out.push(createPortal(<DraftBox d={s.draft} />, box, 'draft'));
  for (const c of s.comments) {
    const host = commentHost(`c:${c.id}`);
    if (host && s.draft?.editing !== c.id) out.push(createPortal(<Card c={c} />, host, `c:${c.id}`));
  }
  return <>{out}</>;
}

function Chip() {
  return (
    // mousedown would otherwise move focus and collapse the selection the comment is about
    <button type="button" className="comment-chip" onMouseDown={(e) => e.preventDefault()}
      onClick={() => startComment()}>✎ Comment</button>
  );
}

function DraftBox({ d }: { d: DeepReadonly<Draft> }) {
  const s = useApp();
  const editing = d.editing;
  const n = s.comments.length + (editing === null ? 1 : 0);
  const blank = !d.text.trim();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches(e, 'comments.send')) {
      e.preventDefault();
      if (!blank) void sendComments();
    } else if (matches(e, 'comments.save')) {
      e.preventDefault();
      saveDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void cancelDraft();
    }
  };
  return (
    <div className="comment-box">
      <div className="comment-head">{editing === null ? 'Comment on' : 'Editing'} {location(d)}</div>
      <textarea rows={3} placeholder="Tell the agent what to change" aria-label="Comment" value={d.text}
        ref={(el) => {
          if (!el || !d.focus || document.activeElement === el) return;
          el.focus({ preventScroll: true });
          const at = d.caret ?? el.value.length;
          el.setSelectionRange(at, at);
        }}
        onSelect={(e) => draftCaret(d, e.currentTarget.selectionStart)}
        onFocus={() => draftFocus(d, true)}
        // a textarea the editor just detached blurs too, and so does every element when the owner
        // switches apps; both come back
        onBlur={(e) => { if (e.currentTarget.isConnected && document.hasFocus()) draftFocus(d, false); }}
        onChange={(e) => editDraft(d, e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown} />
      <div className="comment-actions">
        {editing !== null && <Button variant="ghost" onClick={() => deleteComment(editing)}>Delete</Button>}
        <Button variant="ghost" onClick={() => void cancelDraft()}>Cancel</Button>
        <Button disabled={blank} onClick={() => saveDraft()}>
          {editing === null ? 'Add' : 'Save'} <Kbd>{keyLabel('comments.save')}</Kbd>
        </Button>
        <Button variant="primary" disabled={blank} onClick={() => void sendComments()}>
          Send {n} <Kbd>{keyLabel('comments.send')}</Kbd></Button>
      </div>
    </div>
  );
}

function Card({ c }: { c: DeepReadonly<Comment> }) {
  return (
    <div className="comment-card">
      <button type="button" className="comment-open" title="Edit comment" onClick={() => editComment(c.id)}>
        <span aria-hidden="true">✎</span><span className="txt">{firstLine(c.text)}</span>
      </button>
      <IconButton label="Delete comment" onClick={() => deleteComment(c.id)}>✕</IconButton>
    </div>
  );
}

export function PendingPill() {
  const s = useApp();
  const n = s.comments.length;
  if (!n) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="pill pending" title="Comments waiting to be sent">✎ {n} pending ▾</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu pending-menu" align="end" sideOffset={4}>
          {sortComments(s.comments).map((c) => (
            <DropdownMenu.Item key={c.id} className="menu-item" onSelect={() => void jumpToComment(c.id)}>
              <span className="loc">{location(c)}</span>
              <span className="detail">{firstLine(c.text)}{c.moved ? ' · moved' : ''}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void sendComments()}>Send {n}…</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void discardComments()}>
            Discard all
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
