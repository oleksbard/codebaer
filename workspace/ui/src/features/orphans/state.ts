import type { OrphanScan } from './orphans';

declare module '#kernel/store' {
  interface State {
    /** The debug orphan finder's last scan; set while its dialog is open. */
    orphans: OrphanScan | null;
  }
}

export const orphansState = () => ({ orphans: null });
