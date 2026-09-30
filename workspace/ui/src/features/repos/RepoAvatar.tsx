import type { CSSProperties } from 'react';
import { GlyphSvg } from '#features/command-icons';
import { hueOf, type Avatar } from './avatar';

const STAR = 'M8 2.05 9.47 6.28 13.94 6.37 10.38 9.07 11.67 13.36 8 10.8 4.33 13.36 5.62 9.07 2.06 6.37 6.53 6.28Z';

/** Hidden from a screen reader, so a row that shows `favorite` says so in its own text. */
export function RepoAvatar({ path, avatar, favorite = false, large = false }: {
  path: string;
  avatar: Avatar | undefined;
  favorite?: boolean;
  large?: boolean;
}) {
  const style = { '--hue': `var(--hue-${hueOf(path)})` } as CSSProperties;
  return (
    <span className={large ? 'repo-avatar large' : 'repo-avatar'} style={style} aria-hidden="true">
      {avatar?.icon ? <GlyphSvg key={avatar.icon.body} g={avatar.icon} className="icon-in" /> : avatar?.code}
      {favorite && <svg className="repo-fav" viewBox="0 0 16 16"><path d={STAR} /></svg>}
    </span>
  );
}
