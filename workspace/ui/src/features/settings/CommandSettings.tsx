import { useEffect, useState } from 'react';
import { CommandIcon, ensureIcons, IconPicker } from '#features/command-icons';
import type { CustomCommand } from '#ipc/settings';
import { homeFrom, shortCwd } from '#features/terminals';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { Checkbox } from '#ui/Checkbox';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Pill } from '#ui/Pill';
import { Segmented } from '#ui/Segmented';
import { commandGroups, commandTitle, HIDDEN_TASK_MS } from './commands';
import { saveCommands } from './settings';

const PENCIL = 'M10.5 2.75l2.75 2.75L6 12.75H3.25V10z';
const TRASH = 'M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.75h6.3l.6-8.75';
/** A ToggleGroup value is a string, and no repo root can be this one. */
const GLOBAL = 'global';

/** The entry being edited is held by reference: a save or a failed one replaces the list around it. */
type Editing = DeepReadonly<CustomCommand> | 'new' | null;

/** Entries have no id of their own, and an index key would hand one row's form to its neighbour on a delete. */
const keys = new WeakMap<DeepReadonly<CustomCommand>, number>();
let nextKey = 0;
function keyOf(c: DeepReadonly<CustomCommand>): number {
  let k = keys.get(c);
  if (k === undefined) {
    k = nextKey++;
    keys.set(c, k);
  }
  return k;
}

function repoLabel(repo: string, root: string | null): string {
  return shortCwd(repo, homeFrom(root ?? repo));
}

function CommandForm({ initial, onSave, onCancel }: {
  initial: DeepReadonly<CustomCommand>;
  onSave(c: CustomCommand): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [scope, setScope] = useState(initial.repo ?? GLOBAL);
  const [hide, setHide] = useState(initial.hide_terminal);
  const [icon, setIcon] = useState(initial.icon);
  const root = useApp().root;
  const repos = [...new Set([root, initial.repo].filter((r): r is string => r !== null))];
  const scopes = [
    ...repos.map((r) => ({ value: r, label: r === root ? 'This repository' : repoLabel(r, root) })),
    { value: GLOBAL, label: 'Every repository' },
  ];
  const ok = command.trim() !== '';
  return (
    <form className="cmd-form" onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      const repo = scope === GLOBAL ? null : scope;
      onSave({ name: name.trim(), command: command.trim(), repo, hide_terminal: hide, icon });
    }}>
      <label className="cmd-field">
        <span>Name</span>
        <input type="text" autoComplete="off" spellCheck={false} value={name} placeholder="Optional"
          onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="cmd-field">
        <span>Command</span>
        <input type="text" className="mono" autoComplete="off" spellCheck={false} autoFocus value={command}
          placeholder="pnpm test --watch=false" onChange={(e) => setCommand(e.target.value)} />
      </label>
      <div className="cmd-field">
        <span id="cmd-icon">Icon</span>
        <IconPicker value={icon} name={name.trim()} command={command.trim()} labelledBy="cmd-icon"
          onChange={setIcon} />
      </div>
      <div className="cmd-field">
        <span id="cmd-scope">Show in</span>
        <Segmented value={scope} items={scopes} aria-labelledby="cmd-scope" onValueChange={setScope} />
      </div>
      <div className="cmd-check">
        <label>
          <Checkbox checked={hide} onCheckedChange={setHide} aria-describedby="cmd-hide" />
          Hide terminal
        </label>
        <span id="cmd-hide" className="cmd-hint">
          No output window opens. The command closes when it ends, or is stopped after
          {' '}{HIDDEN_TASK_MS / 60_000} minutes.
        </span>
      </div>
      <div className="dialog-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={!ok}>Save</Button>
      </div>
    </form>
  );
}

function CommandRow({ c, onEdit, onDelete }: { c: DeepReadonly<CustomCommand>; onEdit(): void; onDelete(): void }) {
  const title = commandTitle(c);
  return (
    <div className="cmd-row">
      <CommandIcon name={c.name} command={c.command} icon={c.icon} />
      <div className="cmd-text">
        <span className="cmd-name">{title}</span>
        {title !== c.command && <code className="cmd-line">{c.command}</code>}
      </div>
      {c.hide_terminal && <Pill>Terminal hidden</Pill>}
      <IconButton label={`Edit ${title}`} onClick={onEdit}><StrokeIcon d={PENCIL} size={14} /></IconButton>
      <IconButton label={`Delete ${title}`} onClick={onDelete}><StrokeIcon d={TRASH} size={14} /></IconButton>
    </div>
  );
}

export function CommandsPane() {
  const s = useApp();
  const [editing, setEditing] = useState<Editing>(null);
  const root = s.root;
  useEffect(() => {
    void ensureIcons(s.commands.filter((c) => c.icon === null));
  }, [s.commands]);
  // a list read again from the file holds new objects, so an entry being edited may have gone
  const open = editing === 'new' || (editing !== null && s.commands.includes(editing)) ? editing : null;
  const save = (c: CustomCommand) => {
    const list = open === 'new' ? [...s.commands, c] : s.commands.map((x) => (x === open ? c : x));
    setEditing(null);
    void saveCommands(list);
  };
  const title = (repo: string | null) =>
    repo === null ? 'Every repository' : repo === root ? 'This repository' : repoLabel(repo, root);
  return (
    <>
      <p className="setting-desc cmd-intro">
        Run these from the play button in the activity bar. A command runs in the repository root through your
        login shell, and its output opens in a window you can close while it runs, unless the command hides its
        terminal. Scripts from the root package.json are listed there too. A command saved for another repository
        shows up only there.
      </p>
      {commandGroups(s.commands, root).map((g) => (
        <section key={g.repo ?? GLOBAL} className="cmd-group">
          <h4 className="theme-group-title">
            {title(g.repo)}
            {g.repo === root && root !== null && <span className="cmd-path">{repoLabel(root, root)}</span>}
          </h4>
          {g.commands.length === 0 && <div className="cmd-empty">No commands</div>}
          {g.commands.map((c) => (c === open
            ? <CommandForm key={keyOf(c)} initial={c} onSave={save} onCancel={() => setEditing(null)} />
            : <CommandRow key={keyOf(c)} c={c} onEdit={() => setEditing(c)}
              onDelete={() => void saveCommands(s.commands.filter((x) => x !== c))} />))}
        </section>
      ))}
      {open === 'new'
        ? <CommandForm initial={{ name: '', command: '', repo: root, hide_terminal: false, icon: null }} onSave={save}
          onCancel={() => setEditing(null)} />
        : <Button className="cmd-add" onClick={() => setEditing('new')}>Add command</Button>}
    </>
  );
}
