import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { CommandIcon, ensureIcons } from '#features/command-icons';
import { errKind, errText, type Scripts } from '#ipc/git';
import { commandTitle, inMenu, openSettings, scriptHidden } from '#features/settings';
import * as term from '#features/terminals';
import { isExited, isTask, killTerminal, statusLabel, type TermIcon } from '#features/terminals';
import type { Info, Task } from '#ipc/terminal';
import { useApp, type DeepReadonly } from '#kernel/store';
import { GearIcon, PlayIcon } from '#ui/AppIcons';
import { Button } from '#ui/Button';
import { Dialog } from '#ui/Dialog';
import { StrokeIcon } from '#ui/Icon';
import { inertOnClose, keepFocus } from '#ui/focus';
import { Tip } from '#ui/Tip';
import { useLatest } from '#ui/useLatest';
import { closeTask, openTask, promoteTask, runTask, taskMenu } from './runner';
import { outcome, withoutSharedPrefix } from './tasks';

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

/** What the Commands menu lists. `load` reads the repo's scripts again, for a menu that opens. */
function useTaskList() {
  const app = useApp();
  const [listed, setListed] = useState<Listed | null>(null);
  const load = async () => {
    const root = app.root;
    let found: Scripts | null = null;
    try {
      found = await taskMenu();
      setListed({ root, scripts: found, error: null });
    } catch (e) {
      // with no folder open there is no package.json to read
      setListed({ root, scripts: null, error: errKind(e) === 'NotARepo' ? null : errText(e) });
    }
    const unpicked = app.commands.filter((c) => inMenu(c, root) && c.icon === null);
    const shownScripts = (found?.scripts ?? []).filter((sc) => !scriptHidden(app.hiddenScripts, root, sc.name));
    void ensureIcons([...unpicked, ...shownScripts]);
  };
  return { listed, load };
}

type Run = (task: Task, icon: TermIcon) => void;

/** The body of the Commands menu, in the Commands button's menu and in the app menu's Commands submenu. */
function TaskItems({ listed, run }: { listed: Listed | null; run: Run }) {
  const app = useApp();
  const tasks = app.terminals.filter(isTask);
  const saved = app.commands.filter((c) => inMenu(c, app.root));
  const here = listed?.root === app.root ? listed : null;
  const scripts = (here?.scripts?.scripts ?? []).filter((sc) => !scriptHidden(app.hiddenScripts, app.root, sc.name));
  const shown = withoutSharedPrefix(scripts.map((sc) => sc.command));
  return (
    <>
      <div className="task-scroll">
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
        {saved.map((c, i) => {
          const icon = <CommandIcon name={c.name} command={c.command} icon={c.icon} />;
          return (
            <Tip key={i} label={c.command} side="right" mono slow>
              <DropdownMenu.Item className="menu-item"
                onSelect={() => run({ t: 'Custom', ...c }, { name: c.name, command: c.command, icon: c.icon })}>
                {commandTitle(c) === c.command
                  ? <span className="name wide">{icon}{c.command}</span>
                  : <><span className="name">{icon}{commandTitle(c)}</span><Command text={c.command} /></>}
              </DropdownMenu.Item>
            </Tip>
          );
        })}
        {here?.error && <div className="menu-empty">{here.error}</div>}
        {here?.scripts && scripts.length > 0 && (
          <>
            <DropdownMenu.Separator className="menu-sep" />
            <div className="menu-label">package.json · {here.scripts.runner}</div>
            {scripts.map((sc, i) => (
              <Tip key={sc.name} label={sc.command} side="right" mono slow>
                <DropdownMenu.Item className="menu-item"
                  onSelect={() => run({ t: 'Script', name: sc.name }, { ...sc, icon: null })}>
                  <span className="name">
                    <CommandIcon name={sc.name} command={sc.command} icon={null} />{sc.name}
                  </span>
                  <Command text={shown[i] ?? sc.command} />
                </DropdownMenu.Item>
              </Tip>
            ))}
          </>
        )}
      </div>
      <DropdownMenu.Separator className="menu-sep" />
      <DropdownMenu.Item className="menu-item menu-foot" onSelect={() => void openSettings('commands')}>
        <GearIcon />Manage commands…
      </DropdownMenu.Item>
    </>
  );
}

export function TaskMenu() {
  const app = useApp();
  const { listed, load } = useTaskList();
  // the icon's key, so each hidden run remounts it and plays the animation again
  const [launched, setLaunched] = useState(0);
  const running = app.terminals.filter((t) => isTask(t) && !isExited(t)).length;
  const run: Run = (task, icon) => {
    if (task.t === 'Custom' && task.hide_terminal) setLaunched((n) => n + 1);
    void runTask(task, icon);
  };
  const label = running ? `Commands - ${running} running` : 'Commands';
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void load(); }}>
      <Tip label={label} side="right">
        <DropdownMenu.Trigger asChild>
          <button type="button" className="rail-item task-b" aria-label={label}>
            <span className="tile">
              <span className={launched ? 'tab-icon launch' : 'tab-icon'} key={launched}>
                <PlayIcon />
                {running > 0 && <span className="tab-count" aria-hidden="true">{running}</span>}
              </span>
            </span>
            <span className="cap">Commands</span>
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu term-menu task-menu" side="right" align="start" sideOffset={6}
          collisionPadding={8} ref={inertOnClose} onCloseAutoFocus={keepFocus}>
          <TaskItems listed={listed} run={run} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The Commands menu as a submenu of another `DropdownMenu`. */
export function TaskSubmenu() {
  const { listed, load } = useTaskList();
  return (
    <DropdownMenu.Sub onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenu.SubTrigger className="menu-item menu-sub">
        <PlayIcon />Commands<span className="chev"><StrokeIcon d="M6.5 4.5 10 8l-3.5 3.5" size={12} /></span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="menu term-menu task-menu" sideOffset={6} collisionPadding={8}
          ref={inertOnClose}>
          <TaskItems listed={listed} run={(task, icon) => void runTask(task, icon)} />
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
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
          <Tip label="Keep this session in the terminal rail, where it stays after it ends">
            <Button onClick={() => void promoteTask(s.id)}>Move to Terminals</Button>
          </Tip>
        </span>
      </div>
      <TaskTerm id={s.id} />
    </Dialog>
  );
}

export function TaskOverlay() {
  const app = useApp();
  const found = app.terminals.find((t) => t.id === app.taskView);
  // the store field is already null while this exits: the last session it had is what it fades out showing
  const s = useLatest(found && isTask(found) ? found : null);
  return s ? <TaskDialog key={s.id} session={s} /> : null;
}
