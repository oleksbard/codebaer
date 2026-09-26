import { useEffect, useState } from 'react';
import { logError } from '#ipc/log';
import { useApp } from '#kernel/store';
import { CommandIcon, GlyphSvg } from './CommandIcon';
import { glyph, loadIconSets, searchIcons } from './icons';

const SHOWN = 160;

export function IconPicker({ value, name, command, labelledBy, onChange }: {
  value: string | null;
  name: string;
  command: string;
  labelledBy: string;
  onChange(icon: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // re-renders once the sets have loaded
  useApp();
  useEffect(() => {
    if (open) loadIconSets().catch((e: unknown) => logError(e, 'load icon sets'));
  }, [open]);
  const pick = (icon: string | null) => {
    onChange(icon);
    setOpen(false);
  };
  const ids = open ? searchIcons(query, SHOWN) : [];
  return (
    <div className="icon-pick">
      <button type="button" className="icon-pick-b" aria-expanded={open} aria-labelledby={labelledBy}
        onClick={() => setOpen((o) => !o)}>
        <CommandIcon name={name} command={command} icon={value} />
        <span>{value === null ? 'Automatic' : value.slice(value.indexOf(':') + 1)}</span>
      </button>
      {open && (
        <div className="icon-panel">
          <div className="icon-panel-head">
            {/* no form owner, so Enter here does not save the command */}
            <input type="search" form="icon-search" aria-label="Search icons" placeholder="Search icons"
              autoComplete="off" spellCheck={false} autoFocus value={query}
              onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className="icon-auto" aria-pressed={value === null} onClick={() => pick(null)}
              title="The AI picks one from the name and the command">
              Automatic
            </button>
          </div>
          <div className="icon-grid" role="group" aria-label="Icons">
            {ids.map((id) => {
              const g = glyph(id);
              return g && (
                <button key={id} type="button" className="icon-cell" title={id} aria-label={id}
                  aria-pressed={id === value} onClick={() => pick(id)}>
                  <GlyphSvg g={g} />
                </button>
              );
            })}
          </div>
          {ids.length === 0 && <div className="icon-none">{query.trim() ? 'No icon matches' : 'Loading icons…'}</div>}
        </div>
      )}
    </div>
  );
}
