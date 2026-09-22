import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import * as term from '../terminal';
import { homeFrom, isExited, statusLabel } from '../terminal-status';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { closeTerminal, killTerminal, newTerminal, selectTerminal } from './controller';
import { S, useApp } from './store';

export function TerminalsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.5 6.25 6.75 8 4.5 9.75M8.75 10.25h3" />
    </svg>
  );
}

/** A running session's elapsed time is only true while it is being redrawn. */
function useTick(active: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function Terminals() {
  useApp();
  const host = useRef<HTMLDivElement>(null);
  const id = S.activeTerm;
  const running = S.terminals.some((t) => t.state.t === 'Running');
  useTick(running);

  useEffect(() => {
    if (id !== null && host.current) {
      term.mount(id, host.current);
      term.focus(id);
    }
  }, [id]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (S.activeTerm !== null) term.fit(S.activeTerm);
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="main">
      <TitleBar />
      {S.termError && <div className="banner conflict">{S.termError}</div>}
      <div className="term-host" ref={host} hidden={id === null} />
      {id === null && <Empty />}
    </main>
  );
}

function Empty() {
  const m = S.termMenu;
  return (
    <div className="blank">
      <div>
        <h2>No terminals</h2>
        <p>Sessions keep running across a rebuild, and stop when you quit.</p>
        <p>
          <Button variant="primary" onClick={() => void newTerminal()}>
            New terminal {m ? <span className="dim">{m.default.split('/').pop()}</span> : null} <Kbd>⌘T</Kbd>
          </Button>
        </p>
      </div>
    </div>
  );
}

function Dot({ session }: { session: term.Info }) {
  const tone = isExited(session) ? 'off' : session.state.t === 'Running' ? 'run' : 'idle';
  return <span className={`term-dot ${tone}`} aria-hidden="true" />;
}

function TitleBar() {
  const active = S.terminals.find((t) => t.id === S.activeTerm) ?? null;
  const home = active ? homeFrom(active.cwd) : null;
  return (
    <div className="tbar">
      <Picker active={active} home={home} />
      {active && <span className="pos">{statusLabel(active, Date.now(), home)}</span>}
      <div className="right">
        <Find />
        {active && (
          <IconButton label="Clear the buffer" onClick={() => term.clear(active.id)}>⌫</IconButton>
        )}
        <IconButton label="Smaller text" onClick={() => term.setFontSize(term.fontSize() - 1)}>A−</IconButton>
        <IconButton label="Larger text" onClick={() => term.setFontSize(term.fontSize() + 1)}>A+</IconButton>
        {active && (
          <IconButton
            label={isExited(active) ? 'Close this session' : 'Kill this session'}
            onClick={() => void (isExited(active) ? closeTerminal(active.id) : killTerminal(active.id))}
          >
            ✕
          </IconButton>
        )}
      </div>
    </div>
  );
}

function Find() {
  const id = S.activeTerm;
  if (id === null) return null;
  return (
    <input
      className="term-find"
      type="search"
      placeholder="Find"
      aria-label="Find in terminal"
      defaultValue={S.termFind}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const q = e.currentTarget.value;
        S.termFind = q;
        term.find(id, q, e.shiftKey);
      }}
    />
  );
}

function Picker({ active, home }: { active: term.Info | null; home: string | null }) {
  const m = S.termMenu;
  const label = active ? `${active.title} - ${statusLabel(active, Date.now(), home)}` : 'Terminals';
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="term-pick">
          {active && <Dot session={active} />}
          <span className="txt">{label}</span>
          <span className="caret" aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu term-menu" align="start" sideOffset={6}>
          {S.terminals.length > 0 && <div className="menu-label">Sessions</div>}
          {S.terminals.map((s) => (
            <DropdownMenu.Item
              key={s.id}
              className="menu-item term-row"
              onSelect={() => selectTerminal(s.id)}
            >
              <Dot session={s} />
              <span className="name">{s.title}</span>
              <span className="detail">{statusLabel(s, Date.now(), homeFrom(s.cwd))}</span>
              {S.termAttention.has(s.id) && <span className="term-bell" aria-label="Wants attention">●</span>}
              <button
                type="button"
                className="term-x"
                aria-label={isExited(s) ? 'Close' : 'Kill'}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void (isExited(s) ? closeTerminal(s.id) : killTerminal(s.id));
                }}
              >
                ✕
              </button>
            </DropdownMenu.Item>
          ))}
          {S.terminals.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          <div className="menu-label">New terminal</div>
          {(m?.shells ?? []).map((sh) => (
            <DropdownMenu.Item
              key={sh.path}
              className="menu-item"
              onSelect={() => void newTerminal({ t: 'Shell', path: sh.path })}
            >
              {sh.name}
              {sh.path === m?.default && <span className="detail">default ⌘T</span>}
            </DropdownMenu.Item>
          ))}
          {(m?.commands ?? []).length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {(m?.commands ?? []).map((c) => (
            <DropdownMenu.Item
              key={c}
              className="menu-item"
              onSelect={() => void newTerminal({ t: 'Command', argv0: c })}
            >
              {c}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
