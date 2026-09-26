import { RadioGroup as RG } from 'radix-ui';
import { CHECK, StrokeIcon } from '#ui/Icon';
import { THEMES, type Theme } from '#ui/theme';

const GROUPS = [{ title: 'Dark', dark: true }, { title: 'Light', dark: false }] as const;

/** The app in miniature: its data-theme rescopes every token inside, so it paints in that theme
 *  whatever the window is in. Header dots, the frame on the chrome, a sidebar and a diff. */
function Preview({ id }: { id: Theme }) {
  return (
    <span className="theme-preview" data-theme={id} aria-hidden="true">
      <span className="tp-head"><span /><span /><span /></span>
      <span className="tp-frame">
        <span className="tp-side">
          <span className="tp-row" />
          <span className="tp-row on" />
          <span className="tp-row" />
          <span className="tp-row short" />
        </span>
        <span className="tp-code">
          <span className="tp-line"><span className="kw" /><span className="fn" /><span className="tx" /></span>
          <span className="tp-line add"><span className="ty" /><span className="tx" /><span className="st" /></span>
          <span className="tp-line del"><span className="kw" /><span className="co" /><span className="tx" /></span>
          <span className="tp-line"><span className="cm" /></span>
          <span className="tp-line"><span className="fn" /><span className="st" /></span>
        </span>
      </span>
    </span>
  );
}

export function ThemePicker({ value, onValueChange, ...aria }: {
  value: Theme;
  onValueChange(t: Theme): void;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <RG.Root className="themes" value={value} {...aria}
      onValueChange={(v) => { const t = THEMES.find((x) => x.id === v); if (t) onValueChange(t.id); }}>
      {GROUPS.map((g) => (
        <div key={g.title} className="theme-group" role="group" aria-labelledby={`themes-${g.title}`}>
          <h4 className="theme-group-title" id={`themes-${g.title}`}>{g.title}</h4>
          <div className="theme-grid">
            {THEMES.filter((t) => t.dark === g.dark).map((t) => (
              <RG.Item key={t.id} value={t.id} className="theme-card">
                <span className="theme-swatch"><Preview id={t.id} /></span>
                <span className="theme-label">
                  <span className="theme-name">{t.label}</span>
                  <RG.Indicator className="theme-check"><StrokeIcon d={CHECK} size={12} /></RG.Indicator>
                </span>
              </RG.Item>
            ))}
          </div>
        </div>
      ))}
    </RG.Root>
  );
}
