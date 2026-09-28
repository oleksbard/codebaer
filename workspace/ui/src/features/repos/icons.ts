import { glyph, iconAsker } from '#features/command-icons';
import { git, type RepoItem } from '#ipc/git';
import { notify } from '#kernel/store';
import { hasAvatarIcon, setAvatarIcon } from './avatar';

/** Quiet when the AI fails: the code draws the avatar well enough, and the header would ask on every launch. */
export const ensureRepoIcons = iconAsker<RepoItem>({
  key: (r) => `${r.path}\n${r.name}`,
  has: hasAvatarIcon,
  ask: (items, sets) => git.aiRepoIcons(items.map(({ path, name }) => ({ path, name })), sets),
  keep: (picks) => {
    for (const [r, id] of picks) {
      const g = glyph(id);
      if (g) setAvatarIcon(r, g);
    }
    notify();
  },
  what: 'pick repo icons',
  warn: null,
});
