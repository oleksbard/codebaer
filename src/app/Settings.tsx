import { useState } from 'react';
import { Tabs as RT } from 'radix-ui';
import { SECTIONS, type Option } from '../settings';
import { Dialog } from '../ui/Dialog';
import { Segmented } from '../ui/Segmented';
import { closeSettings, setSetting } from './controller';
import { S } from './store';
import { ThemePicker } from './ThemePicker';

function OptionText({ option, id }: { option: Option; id: string }) {
  return (
    <div className="setting-text">
      <span className="setting-label" id={`${id}-label`}>{option.label}</span>
      <code className="setting-key">{option.key}</code>
      <p className="setting-desc" id={`${id}-desc`}>{option.description}</p>
    </div>
  );
}

function OptionRow({ option }: { option: Option }) {
  const id = `setting-${option.key}`;
  const aria = { 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-desc` };
  if (option.key === 'appearance.theme') {
    return (
      <div className="setting stacked">
        <OptionText option={option} id={id} />
        <ThemePicker value={S.settings[option.key]} {...aria} onValueChange={(v) => void setSetting(option.key, v)} />
      </div>
    );
  }
  return (
    <div className="setting">
      <OptionText option={option} id={id} />
      <Segmented value={S.settings[option.key]} items={option.choices} {...aria}
        onValueChange={(v) => void setSetting(option.key, v)} />
    </div>
  );
}

export function SettingsDialog() {
  const [section, setSection] = useState(SECTIONS[0]!.id);
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
              {s.options.map((o) => <OptionRow key={o.key} option={o} />)}
            </div>
          </RT.Content>
        ))}
      </RT.Root>
    </Dialog>
  );
}
