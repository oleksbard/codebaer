import { useState } from 'react';
import { Tabs as RT } from 'radix-ui';
import { SetIcon } from '#features/command-icons';
import { useApp } from '#kernel/store';
import { Dialog } from '#ui/Dialog';
import { InfoTip } from '#ui/InfoTip';
import { Segmented } from '#ui/Segmented';
import { SECTIONS, type Option } from './catalog';
import { CommandsPane } from './CommandSettings';
import { closeSettings, setSetting } from './settings';
import { ThemePicker } from './ThemePicker';

function OptionText({ option, id }: { option: Option; id: string }) {
  const uses = option.uses?.() ?? [];
  return (
    <div className="setting-text">
      <div className="setting-head">
        <span className="setting-label" id={`${id}-label`}>{option.label}</span>
        {uses.length > 0 && (
          <InfoTip label={`What uses the ${option.label.replace(/^\w/, (c) => c.toLowerCase())}`}>
            <p>Used by:</p>
            <ul>{uses.map((u) => <li key={u.label}><SetIcon id={u.icon} />{u.label}</li>)}</ul>
          </InfoTip>
        )}
      </div>
      <p className="setting-desc" id={`${id}-desc`}>{option.description}</p>
      <code className="setting-key">{option.key}</code>
    </div>
  );
}

function OptionRow({ option }: { option: Option }) {
  const s = useApp();
  const id = `setting-${option.key}`;
  const aria = { 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-desc` };
  if (option.key === 'appearance.theme') {
    return (
      <div className="setting stacked">
        <OptionText option={option} id={id} />
        <ThemePicker value={s.settings[option.key]} {...aria} onValueChange={(v) => void setSetting(option.key, v)} />
      </div>
    );
  }
  const off = option.unavailable?.() ?? new Map<string, string>();
  const items = option.choices.map((c) => ({ ...c, disabled: off.has(c.value), title: off.get(c.value) }));
  return (
    <div className="setting">
      <OptionText option={option} id={id} />
      <Segmented value={s.settings[option.key]} items={items} {...aria}
        onValueChange={(v) => void setSetting(option.key, v)} />
    </div>
  );
}

export function SettingsDialog() {
  const app = useApp();
  const [section, setSection] = useState(app.settingsSection);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeSettings(); }} title="Settings" className="settings">
      <RT.Root className="settings-body" orientation="vertical" value={section} onValueChange={setSection}>
        <div className="settings-side">
          {/* the dialog is already named by its hidden title */}
          <h2 className="dialog-title" aria-hidden="true">Settings</h2>
          <RT.List className="settings-nav" aria-label="Sections">
            {SECTIONS.map((s) => <RT.Trigger key={s.id} className="settings-tab" value={s.id}>{s.label}</RT.Trigger>)}
          </RT.List>
        </div>
        {SECTIONS.map((s) => (
          // Radix makes the panel a tab stop, which WAI-ARIA wants only for a panel with nothing focusable in it
          <RT.Content key={s.id} className="settings-pane" value={s.id} tabIndex={-1}>
            <h3 className="settings-pane-title">{s.label}</h3>
            <div className="settings-pane-body">
              {s.id === 'commands' ? <CommandsPane /> : s.options.map((o) => <OptionRow key={o.key} option={o} />)}
            </div>
          </RT.Content>
        ))}
      </RT.Root>
    </Dialog>
  );
}
