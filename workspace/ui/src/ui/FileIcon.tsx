import { themeIcons } from 'seti-icons';

// Seti's ten colour names mapped onto the theme tokens, so icons re-tint with the theme
// instead of carrying Seti's own hard-coded hexes.
const icon = themeIcons({
  blue: 'var(--hue-blue)',
  green: 'var(--hue-green)',
  grey: 'var(--faint)',
  'grey-light': 'var(--muted)',
  ignore: 'var(--faint)',
  orange: 'var(--hue-orange)',
  pink: 'var(--hue-pink)',
  purple: 'var(--hue-purple)',
  red: 'var(--hue-red)',
  white: 'var(--text)',
  yellow: 'var(--hue-yellow)',
});

export function FileIcon({ name }: { name: string }) {
  const { svg, color } = icon(name);
  return <span className="ficon" style={{ color }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
