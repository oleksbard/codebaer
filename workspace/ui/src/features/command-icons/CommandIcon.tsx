import { useApp } from '#kernel/store';
import { StrokeIcon } from '#ui/Icon';
import { glyph, iconKey, type Glyph } from './icons';

const PROMPT = 'M3.5 4.75L6.75 8 3.5 11.25M8.75 11.5h3.75';

export function GlyphSvg({ g }: { g: Glyph }) {
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: g.body }} />;
}

/** The user's pick, else the AI's, else a prompt sign, which also stands in while the icon sets load. */
export function CommandIcon({ name, command, icon }: { name: string; command: string; icon: string | null }) {
  const picks = useApp().commandIcons;
  const g = glyph(icon) ?? glyph(picks[iconKey(name, command)] ?? null);
  return <span className="cicon" aria-hidden="true">{g ? <GlyphSvg g={g} /> : <StrokeIcon d={PROMPT} />}</span>;
}
