import { IconPicker } from '#features/command-icons';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { Checkbox } from '#ui/Checkbox';
import { Dialog } from '#ui/Dialog';
import { useLatest } from '#ui/useLatest';
import { closeRepoPrefs, setFavorite, setRepoIcon } from './actions';
import { avatars, pickedIcon } from './avatar';
import { RepoAvatar } from './RepoAvatar';
import type { RepoPrefs } from './state';

export function RepoPrefsOverlay() {
  const s = useApp();
  // the store field is already null while this exits: the last prefs it had are what it fades out showing
  const prefs = useLatest(s.repoPrefs);
  return prefs ? <RepoPrefsDialog prefs={prefs} /> : null;
}

function RepoPrefsDialog({ prefs }: { prefs: DeepReadonly<RepoPrefs> }) {
  const avatar = avatars([{ path: prefs.path, name: prefs.name }]).get(prefs.path);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeRepoPrefs(); }} title={`${prefs.name} preferences`}
      className="repo-prefs">
      <div className="repo-prefs-head">
        <RepoAvatar path={prefs.path} avatar={avatar} favorite={prefs.favorite} large />
        <div className="repo-prefs-title">
          {/* the dialog is already named by its hidden title */}
          <h2 className="dialog-title" aria-hidden="true">{prefs.name}</h2>
          <span className="path">{prefs.label}</span>
        </div>
      </div>
      <div className="repo-prefs-body">
        <div className="repo-prefs-check">
          <label>
            <Checkbox checked={prefs.favorite} onCheckedChange={(v) => void setFavorite(v)}
              aria-describedby="repo-prefs-fav" />
            Favorite
          </label>
          <span id="repo-prefs-fav" className="repo-prefs-hint">
            Listed first in the switcher, and kept there however many other repositories you open.
          </span>
        </div>
        <div className="repo-prefs-field">
          <span id="repo-prefs-icon">Icon</span>
          <IconPicker value={pickedIcon(prefs.path)?.id ?? null} labelledBy="repo-prefs-icon" onChange={setRepoIcon}
            preview={<RepoAvatar path={prefs.path} avatar={avatar} />}
            autoTitle="The AI picks one from the name and the README; the letters stand in until it does" />
        </div>
      </div>
      <div className="dialog-actions">
        <Button variant="primary" onClick={closeRepoPrefs}>Done</Button>
      </div>
    </Dialog>
  );
}
