import { useEffect, useRef, useState, type ReactElement } from 'react';
import { DropdownMenu } from 'radix-ui';
import { termLabels } from '../comments';
import * as term from '../terminal';
import { agentOf, awayLabel, homeFrom, isExited, statusLabel, type Agent } from '../terminal-status';
import { Button } from '../ui/Button';
import { ContextMenu } from '../ui/ContextMenu';
import { Kbd } from '../ui/Kbd';
import { closeTerminal, killTerminal, newTerminal, selectTerminal } from './controller';
import { S, useApp } from './store';

const STILL = globalThis.matchMedia('(prefers-reduced-motion: reduce)');

/** Claude Code's own six marks. The variation selector keeps macOS from serving U+2733 as an emoji. */
const MARK = '✻';
const MARKS = ['·', '✢', '✳\ufe0e', '✶', MARK, '✽'];
const FRAMES = [...MARKS, ...[...MARKS].reverse()];

/** The CLI runs these at 120ms, which reads as a flicker at this size. */
const FRAME_MS = 160;

/** The spinner the agent itself draws while it works: out to the heavy mark and back. */
function ClaudeMark({ busy }: { busy: boolean }) {
  const spin = busy && !STILL.matches;
  const n = useTick(spin, FRAME_MS);
  return <span className="mark" aria-hidden="true">{(spin ? FRAMES[n % FRAMES.length] : MARK) ?? MARK}</span>;
}

function CodexIcon() {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5z" />
      <path d="M8 5.4 10.9 7v2.9L8 11.6 5.1 9.9V7z" />
    </svg>
  );
}

const ICONS: Record<Agent, (p: { busy: boolean }) => ReactElement> = { claude: ClaudeMark, codex: CodexIcon };

function useTick(active: boolean, ms: number): number {
  const [n, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

export function Terminals() {
  useApp();
  const host = useRef<HTMLDivElement>(null);
  const id = S.activeTerm;

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

function Away() {
  return (
    <svg className="away" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 10v3.5h-9v-9H6" />
    </svg>
  );
}

function Dot({ session }: { session: term.Info }) {
  const tone = isExited(session) ? 'off' : session.state.t === 'Running' ? 'run' : 'idle';
  return <span className={`term-dot ${tone}`} aria-hidden="true" />;
}

export function TerminalRail() {
  const active = S.tab === 'terminals' ? S.activeTerm : null;
  const names = termLabels(S.terminals);
  return (
    <div className="rail">
      {S.terminals.map((s) => {
        const wants = S.termAttention.has(s.id);
        const home = homeFrom(s.cwd);
        const away = awayLabel(s, S.root, home);
        // the number and the glyph are both decorative once the label carries the same words
        const label = `${names.get(s.id) ?? s.title} · ${statusLabel(s, Date.now(), home)}${away ? ` · ${away}` : ''}`
          + `${wants ? ' · wants attention' : ''}`;
        return (
          <ContextMenu
            key={s.id}
            items={isExited(s)
              ? [{ label: 'Close', onSelect: () => void closeTerminal(s.id) }]
              : [
                { label: 'Kill', onSelect: () => void killTerminal(s.id) },
                // the host's Close kills a live session before dropping it
                { label: 'Kill & Close', onSelect: () => void closeTerminal(s.id) },
              ]}
          >
            <button
              type="button"
              className={`rail-b${s.id === active ? ' on' : ''}${term.working(s.id) ? ' busy' : ''}`}
              aria-current={s.id === active || undefined}
              aria-label={label}
              title={label}
              onClick={() => selectTerminal(s.id)}
            >
              <Glyph session={s} />
              {away && <Away />}
              <Dot session={s} />
              {wants && <span className="bell" aria-hidden="true" />}
            </button>
          </ContextMenu>
        );
      })}
      <NewMenu />
    </div>
  );
}

/** The session id, not its place in the list: closing one must not renumber the rest. */
function Glyph({ session }: { session: term.Info }) {
  const agent = agentOf(session);
  if (!agent) return <span className="num" aria-hidden="true">{session.id}</span>;
  const Icon = ICONS[agent];
  return <span className={`agent ${agent}`}><Icon busy={term.working(session.id)} /></span>;
}

function NewMenu() {
  const m = S.termMenu;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="rail-b new" title="New terminal (⌘T)" aria-label="New terminal">+</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu term-menu" side="right" align="end" sideOffset={6}>
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
