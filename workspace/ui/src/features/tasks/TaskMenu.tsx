import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { errKind, errText, type Scripts } from '#ipc/git';
import { commandTitle, inMenu, openSettings } from '#features/settings';
import * as term from '#features/terminals';
import { isExited, isTask, killTerminal, statusLabel } from '#features/terminals';
import type { Info, Task } from '#ipc/terminal';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { Dialog } from '#ui/Dialog';
import { closeTask, openTask, promoteTask, runTask, taskMenu } from './runner';
import { outcome, withoutSharedPrefix } from './tasks';

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M5.25 3.25v9.5L12.75 8z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="4" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.5" strokeWidth="1.2" />
      <path d="M12.5 8h2M1.5 8h2M8 12.5v2M8 1.5v2M11.2 11.2l1.4 1.4M3.4 3.4l1.4 1.4M4.8 11.2l-1.4 1.4M12.6 3.4l-1.4 1.4"
        strokeWidth="2" />
    </svg>
  );
}

/** Cut at the start when it does not fit: the end of a command is what tells two apart. */
function Command({ text }: { text: string }) {
  return <span className="detail cut-start"><bdi>{text}</bdi></span>;
}

function tone(s: DeepReadonly<Info>): string {
  if (!isExited(s)) return 'run';
  return outcome(s)?.tone ?? 'info';
}

/** Scripts are read per repo, so a switch never shows the last repo's list, not even for a frame. */
type Listed = { root: string | null; scripts: Scripts | null; error: string | null };

export function TaskMenu() {
  const app = useApp();
  const [listed, setListed] = useState<Listed | null>(null);
  // the icon's key, so each hidden run remounts it and plays the animation again
  const [launched, setLaunched] = useState(0);
  const tasks = app.terminals.filter(isTask);
  const running = tasks.filter((t) => !isExited(t)).length;
  const saved = app.commands.filter((c) => inMenu(c, app.root));
  const here = listed?.root === app.root ? listed : null;
  const scripts = here?.scripts?.scripts ?? [];
  const shown = withoutSharedPrefix(scripts.map((sc) => sc.command));
  const load = async () => {
    const root = app.root;
    try {
      setListed({ root, scripts: await taskMenu(), error: null });
    } catch (e) {
      // a folder that is not a repo has no package.json to speak of
      setListed({ root, scripts: null, error: errKind(e) === 'NotARepo' ? null : errText(e) });
    }
  };
  const run = (task: Task) => {
    if (task.t === 'Custom' && task.hide_terminal) setLaunched((n) => n + 1);
    void runTask(task);
  };
  const label = running ? `Commands - ${running} running` : 'Commands';
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="rail-b task-b" aria-label={label} title={label}>
          <span className={launched ? 'tab-icon launch' : 'tab-icon'} key={launched}>
            <PlayIcon />
            {running > 0 && <span className="tab-count" aria-hidden="true">{running}</span>}
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu term-menu task-menu" side="right" align="start" sideOffset={6}>
          {tasks.length > 0 && (
            <>
              <div className="menu-label">Output</div>
              {tasks.map((t) => (
                <DropdownMenu.Item key={t.id} className="menu-item" onSelect={() => openTask(t.id)}>
                  <span className="name"><span className={`term-dot ${tone(t)}`} aria-hidden="true" />{t.title}</span>
                  <span className="detail">{outcome(t)?.text ?? statusLabel(t, Date.now())}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="menu-sep" />
            </>
          )}
          <div className="menu-label">Commands</div>
          {saved.length === 0 && <div className="menu-empty">None saved{app.root ? ' for this repository' : ''}</div>}
          {saved.map((c, i) => (
            <DropdownMenu.Item key={i} className="menu-item" title={c.command}
              onSelect={() => run({ t: 'Custom', ...c })}>
              {commandTitle(c) === c.command
                ? <span className="name wide">{c.command}</span>
                : <><span className="name">{commandTitle(c)}</span><Command text={c.command} /></>}
            </DropdownMenu.Item>
          ))}
          {here?.error && <div className="menu-empty">{here.error}</div>}
          {here?.scripts && (
            <>
              <DropdownMenu.Separator className="menu-sep" />
              <div className="menu-label">package.json · {here.scripts.runner}</div>
              {scripts.map((sc, i) => (
                <DropdownMenu.Item key={sc.name} className="menu-item" title={sc.command}
                  onSelect={() => run({ t: 'Script', name: sc.name })}>
                  <span className="name">{sc.name}</span><Command text={shown[i] ?? sc.command} />
                </DropdownMenu.Item>
              ))}
            </>
          )}
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item menu-foot" onSelect={() => void openSettings('commands')}>
            <GearIcon />Manage commands…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Its own component so the effect runs once the dialog's portal has put the host in the page. */
function TaskTerm({ id }: { id: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    term.mount(id, el);
    term.focus(id);
    const observer = new ResizeObserver(() => term.fit(id));
    observer.observe(el);
    return () => observer.disconnect();
  }, [id]);
  return <div className="term-host task-term" ref={host} />;
}

function useSecondTick(active: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function TaskDialog({ session: s }: { session: DeepReadonly<Info> }) {
  const running = !isExited(s);
  useSecondTick(running);
  const state = outcome(s)?.text ?? statusLabel(s, Date.now());
  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeTask(); }} title={s.title} className="task">
      <div className="task-head">
        <span className={`term-dot ${tone(s)}`} aria-hidden="true" />
        {/* the dialog is already named by its hidden title */}
        <h2 className="dialog-title" aria-hidden="true">{s.title}</h2>
        <span className={`task-state ${tone(s)}`}>{state}</span>
        <span className="task-acts">
          {running && <Button onClick={() => void killTerminal(s.id)}>Stop</Button>}
          <Button onClick={() => void promoteTask(s.id)}
            title="Keep this session in the terminal rail, where it stays after it ends">
            Move to Terminals
          </Button>
        </span>
      </div>
      <TaskTerm id={s.id} />
    </Dialog>
  );
}

export function TaskOverlay() {
  const app = useApp();
  const s = app.terminals.find((t) => t.id === app.taskView);
  return s && isTask(s) ? <TaskDialog key={s.id} session={s} /> : null;
}
