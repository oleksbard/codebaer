import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { GlyphSvg, pickedGlyph } from '#features/command-icons';
import type { Info } from '#ipc/terminal';
import { keyLabel } from '#kernel/keymap';
import { baseName } from '#kernel/paths';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { ContextMenu } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { inertOnClose, keepFocus } from '#ui/focus';
import { Kbd } from '#ui/Kbd';
import { heavyMotion } from '#ui/motion';
import { Pop } from '#ui/Pop';
import { Presence } from '#ui/Presence';
import { TabIndicator } from '#ui/Tabs';
import { ensureTermIcons, iconFor } from './icons';
import { Away, OutsideBadge } from './OutsideBadge';
import { closeTerminal, killTerminal, newTerminal, selectTerminal } from './sessions';
import {
  agentNamed, agentOf, awayLabel, homeFrom, isExited, statusLabel, termLabels, terminalsOf, type Agent,
} from './status';
import * as term from './xterm';

const STILL = globalThis.matchMedia('(prefers-reduced-motion: reduce)');

/** Claude Code's own six marks. The variation selector keeps macOS from serving U+2733 as an emoji. */
const MARK = '✻';
const MARKS = ['·', '✢', '✳\ufe0e', '✶', MARK, '✽'];
const FRAMES = [...MARKS, ...[...MARKS].reverse()];

/** The CLI runs these at 120ms, which reads as a flicker at this size. */
const FRAME_MS = 160;

/** The spinner the agent itself draws while it works: out to the heavy mark and back. */
function ClaudeMark({ busy }: { busy: boolean }) {
  const spin = busy && !STILL.matches && heavyMotion();
  const n = useTick(spin, FRAME_MS);
  return <span className="mark" aria-hidden="true">{(spin ? FRAMES[n % FRAMES.length] : MARK) ?? MARK}</span>;
}

function CodexIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5z" />
      <path d="M8 5.4 10.9 7v2.9L8 11.6 5.1 9.9V7z" />
    </svg>
  );
}

function OpenCodeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" />
    </svg>
  );
}

const ICONS: Record<Agent, (p: { busy: boolean }) => ReactElement> = {
  claude: ClaudeMark, codex: CodexIcon, opencode: OpenCodeIcon,
};

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** The power sign: one icon for every session that was killed or finished, whatever it ran. */
function EndedIcon() {
  return (
    <svg viewBox="0 0 16 16" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinecap="round" aria-hidden="true">
      <path d="M8 2.4v5.4" />
      <path d="M4.66 4.62a5.2 5.2 0 1 0 6.68 0" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
      <path d="M4.5 6.25 6.5 8l-2 1.75M8.25 9.75h3.25" />
    </svg>
  );
}

/** A runtime wears the Seti icon its source files get in the Files tree. */
const LANGS = new Map([['node', 'index.js'], ['python3', 'main.py']]);

function ProgramIcon({ name }: { name: string }) {
  const agent = agentNamed(name);
  if (agent) {
    const Icon = ICONS[agent];
    return <span className={`prog agent ${agent}`}><Icon busy={false} /></span>;
  }
  const lang = LANGS.get(name);
  return <span className="prog">{lang ? <FileIcon name={lang} /> : <TerminalIcon />}</span>;
}

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
  const s = useApp();
  const host = useRef<HTMLDivElement>(null);
  const id = s.activeTerm;
  const session = s.terminals.find((t) => t.id === id);

  useEffect(() => {
    if (id !== null && host.current) {
      term.mount(id, host.current);
      term.focus(id);
    }
  }, [id]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (s.activeTerm !== null) term.fit(s.activeTerm);
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="main">
      {s.termError && <div className="banner conflict">{s.termError}</div>}
      <div className="term-frame" hidden={id === null}>
        <div className="term-host" ref={host} />
        {session && <OutsideBadge key={session.id} session={session} />}
      </div>
      {id === null && <Empty />}
    </main>
  );
}

function Empty() {
  const m = useApp().termMenu;
  return (
    <div className="blank">
      <div>
        <h2>No terminals</h2>
        <p>Sessions keep running across a rebuild, and stop when you quit.</p>
        <p>
          <Button variant="primary" onClick={() => void newTerminal()}>
            New terminal {m ? <span className="dim">{baseName(m.default)}</span> : null}{' '}
            <Kbd>{keyLabel('terminals.new')}</Kbd>
          </Button>
        </p>
      </div>
    </div>
  );
}

function Dot({ session }: { session: DeepReadonly<Info> }) {
  const tone = isExited(session) ? 'off' : session.state.t === 'Running' ? 'run' : 'idle';
  return <span className={`term-dot ${tone}`} aria-hidden="true" />;
}

export function TerminalRail({ indicatorId }: { indicatorId?: string }) {
  const app = useApp();
  // shares the activity bar's Tabs indicator when the caller passes one; falls back to its own otherwise
  const ownId = useId();
  const id = indicatorId ?? ownId;
  const active = app.tab === 'terminals' ? app.activeTerm : null;
  const sessions = terminalsOf(app.terminals);
  const names = termLabels(sessions);
  const icons = sessions.flatMap((s) => iconFor(s, app.termIcons) ?? []);
  const wanted = [
    app.settings['general.headless-ai-provider'], ...icons.map((it) => `${it.icon}\n${it.name}\n${it.command}`),
  ].join('\0');
  useEffect(() => { ensureTermIcons(icons); }, [wanted]);
  // only a session opening or closing changes this, never a keystroke elsewhere
  const sessionKey = sessions.map((s) => s.id).join(',');
  return (
    <div className="rail">
      <Presence mode={heavyMotion() ? 'popLayout' : 'sync'}>
        {sessions.map((s) => {
          const wants = app.termAttention.has(s.id);
          const home = homeFrom(s.cwd);
          const away = awayLabel(s, app.root, home);
          const name = names.get(s.id) ?? s.title;
          // the number and the glyph are both decorative once the label carries the same words
          const label = `${name} · ${statusLabel(s, Date.now(), home)}${away ? ` · ${away}` : ''}`
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
              <Pop
                className={`rail-item rail-b${s.id === active ? ' on' : ''}${term.working(s.id) ? ' busy' : ''}`
                  + `${away ? ' outside' : ''}`}
                layoutDependency={sessionKey}
                data-term={s.id}
                aria-current={s.id === active || undefined}
                aria-label={label}
                title={label}
                onClick={() => selectTerminal(s.id)}
              >
                <span className="tile">
                  {s.id === active && <TabIndicator id={id} value={active} className="rail-ind" leaveOnExit />}
                  <TermGlyph session={s} fallback={<span className="num" aria-hidden="true">{s.id}</span>} />
                  {away && <Away />}
                  <Dot session={s} />
                  {wants && <span className="bell" aria-hidden="true" />}
                </span>
                <span className="cap">{name}</span>
              </Pop>
            </ContextMenu>
          );
        })}
      </Presence>
      <NewMenu />
    </div>
  );
}

/** What the session's rail button shows: the power sign once it has ended, an agent's mark, else its icon, else
 *  `fallback`. The rail's is the session id, not its place in the list: closing one must not renumber the rest. */
export function TermGlyph({ session, fallback = <TerminalIcon /> }: {
  session: DeepReadonly<Info>; fallback?: ReactNode;
}) {
  const app = useApp();
  if (isExited(session)) return <span className="ended" aria-hidden="true"><EndedIcon /></span>;
  const agent = agentOf(session);
  if (agent) {
    const Icon = ICONS[agent];
    return <span className={`agent ${agent}`}><Icon busy={term.working(session.id)} /></span>;
  }
  const it = iconFor(session, app.termIcons);
  const g = it && pickedGlyph(app.commandIcons, it);
  return g ? <span className="pick" aria-hidden="true"><GlyphSvg g={g} /></span> : fallback;
}

function NewMenu() {
  const m = useApp().termMenu;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="rail-item rail-b new" title={`New terminal (${keyLabel('terminals.new')})`}
          aria-label="New terminal">
          <span className="tile"><PlusIcon /></span>
          <span className="cap">New</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu term-menu" side="right" align="end" sideOffset={6}
          ref={inertOnClose} onCloseAutoFocus={keepFocus}>
          <div className="menu-label">New terminal</div>
          {(m?.shells ?? []).map((sh) => (
            <DropdownMenu.Item
              key={sh.path}
              className="menu-item"
              onSelect={() => void newTerminal({ t: 'Shell', path: sh.path })}
            >
              <ProgramIcon name={sh.name} />
              {sh.name}
              {sh.path === m?.default && <span className="detail">default <Kbd>{keyLabel('terminals.new')}</Kbd></span>}
            </DropdownMenu.Item>
          ))}
          {(m?.commands ?? []).length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {(m?.commands ?? []).map((c) => (
            <DropdownMenu.Item
              key={c}
              className="menu-item"
              onSelect={() => void newTerminal({ t: 'Command', argv0: c })}
            >
              <ProgramIcon name={c} />
              {c}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
