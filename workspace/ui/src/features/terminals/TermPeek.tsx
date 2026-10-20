import { useLayoutEffect, useRef } from 'react';
import { useApp, type DeepReadonly } from '#kernel/store';
import { platform } from '#kernel/platform';
import { HoverCard } from '#ui/HoverCard';
import { OPEN_OUT, StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { enterPeek, leavePeek, openPeeked } from './peek';
import type { PeekBody, TermPeek as Peek } from './state';

const CLICK = platform() === 'macos' ? '⌘-click' : 'Ctrl-click';

/** The card over a file path in a terminal: the lines around the one it names, an image, or a markdown page. */
export function TermPeek() {
  const peek = useApp().termPeek;
  return (
    <HoverCard at={peek?.at ?? null} id={peek?.id ?? 0} className="term-peek" onPointerEnter={enterPeek}
      onPointerLeave={() => { if (peek) leavePeek(peek.id); }}>
      {peek && <Content peek={peek} />}
    </HoverCard>
  );
}

function Content({ peek }: { peek: DeepReadonly<Peek> }) {
  const cut = peek.path.lastIndexOf('/') + 1;
  return (
    <>
      {/* the folders give way first, so the file name and its line always show */}
      <div className="term-peek-head">
        <IconButton label="Open in Default App" tip="Open in Default App" side="top"
          onClick={() => void openPeeked(peek.path)}>
          <StrokeIcon d={OPEN_OUT} size={14} />
        </IconButton>
        <div className="term-peek-path">
          <span className="dir">{peek.path.slice(0, cut)}</span>
          <span className="name">{peek.path.slice(cut)}{peek.line === null ? '' : `:${peek.line}`}</span>
        </div>
        <span className="term-peek-hint">{CLICK} the path</span>
      </div>
      {/* a markdown page is the repository's text, so none of it may take the pointer */}
      <div className="term-peek-body" inert>
        <Body body={peek.body} />
      </div>
    </>
  );
}

function Body({ body }: { body: DeepReadonly<PeekBody> }) {
  switch (body.kind) {
    case 'code':
      return (
        <div className="term-peek-code">
          {body.lines.map((tokens, i) => {
            const n = body.first + i;
            return (
              <div key={n} className={n === body.line ? 'on' : undefined}>
                <span className="num">{n}</span>
                <span className="text">
                  {tokens.map((t, j) => <span key={j} className={t.cls || undefined}>{t.text}</span>)}
                </span>
              </div>
            );
          })}
        </div>
      );
    case 'image':
      return (
        <div className="term-peek-image">
          <img src={body.url} alt="" {...(body.size ? { width: body.size.width, height: body.size.height } : {})} />
        </div>
      );
    case 'markdown':
      return <Markdown html={body.html} />;
    case 'note':
      return <div className="term-peek-note">{body.text}</div>;
  }
}

/** Marked `cut` when the card is too short for the page, which fades its end. */
function Markdown({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.toggleAttribute('data-cut', el.scrollHeight > el.clientHeight);
  }, [html]);
  return <div ref={ref} className="term-peek-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
