import { rowKey, type Row } from './model';
import { esc } from './palette';

export type Tab = 'changes' | 'files';
export type QueueHandlers = {
  openRow(row: Row): void;
  openPlain(path: string): void;
  stageFile(path: string): void;
  revertFile(path: string): void;
  unstageFile(path: string): void;
  commit(message: string): void;
  setTab(tab: Tab): void;
  stageAll(): void;
  unstageAll(): void;
};

const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

export class Queue {
  private list: HTMLElement;
  private commitBox: HTMLElement;
  private msg: HTMLTextAreaElement;
  private rows = new Map<string, Row>();

  constructor(private root: HTMLElement, private h: QueueHandlers) {
    root.innerHTML = `
      <div class="tabs"><button class="tab" data-tab="changes">Changes</button><button class="tab" data-tab="files">Files</button></div>
      <div class="list" tabindex="0"></div>
      <div class="commit">
        <textarea id="commit-message" placeholder="Commit message" aria-label="Commit message"></textarea>
        <div class="bar"><span class="hint"></span><button class="btn primary" id="commit-btn" disabled>Commit <kbd>⌘↩</kbd></button></div>
      </div>`;
    this.list = root.querySelector('.list')!;
    this.commitBox = root.querySelector('.commit')!;
    this.msg = root.querySelector('#commit-message')!;
    root.querySelector('.tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (b) h.setTab(b.dataset.tab as Tab);
    });
    root.querySelector('#commit-btn')!.addEventListener('click', () => h.commit(this.message()));
    this.msg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); h.commit(this.message()); }
    });
    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const all = t.closest('[data-all]') as HTMLElement | null;
      if (all) {
        e.stopPropagation();
        if (all.dataset.all === 'stage') h.stageAll(); else h.unstageAll();
        return;
      }
      const act = t.closest('[data-act]') as HTMLElement | null;
      const rowEl = t.closest('[data-key]') as HTMLElement | null;
      if (act && rowEl) {
        e.stopPropagation();
        const path = this.rows.get(rowEl.dataset.key!)?.path ?? rowEl.dataset.path!;
        if (act.dataset.act === 'stage') h.stageFile(path);
        else if (act.dataset.act === 'revert') h.revertFile(path);
        else if (act.dataset.act === 'unstage') h.unstageFile(path);
        return;
      }
      if (rowEl?.dataset.plain !== undefined) { h.openPlain(rowEl.dataset.path!); return; }
      const row = rowEl && this.rows.get(rowEl.dataset.key!);
      if (row) h.openRow(row);
    });
    this.list.addEventListener('keydown', (e) => {
      if (e.target !== this.list) return;
      const sel = this.list.querySelector('.row.sel') as HTMLElement | null;
      const all = [...this.list.querySelectorAll<HTMLElement>('.row')];
      const i = sel ? all.indexOf(sel) : -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        next?.click();
        e.preventDefault();
      } else if (e.key === 'Enter' && sel) {
        sel.click();
      }
    });
  }

  render(q: { unstaged: Row[]; staged: Row[] }, files: string[], selectedKey: string | null, tab: Tab): void {
    this.root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', (t as HTMLElement).dataset.tab === tab));
    this.commitBox.hidden = tab !== 'changes';
    this.rows.clear();
    if (tab === 'files') {
      const dirs = new Map<string, string[]>();
      for (const p of files) { const [d] = split(p); (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(p); }
      this.list.innerHTML = [...dirs.keys()].sort().map((d) =>
        `<details open><summary class="d">${esc(d || '/')}</summary>${dirs.get(d)!.map((p) =>
          `<div class="row f ${selectedKey === `plain:${p}` ? 'sel' : ''}" data-key="plain:${esc(p)}" data-path="${esc(p)}" data-plain><span class="path">${esc(split(p)[1])}</span></div>`).join('')}</details>`).join('');
      return;
    }
    const rowHtml = (r: Row) => {
      const key = rowKey(r);
      this.rows.set(key, r);
      const [dir, name] = split(r.path);
      const acts = r.section === 'staged'
        ? `<button class="ico" data-act="unstage" title="Unstage file">−</button>`
        : r.conflicted
          ? `<button class="ico" data-act="stage" title="Mark resolved">+</button>`
          : `<button class="ico" data-act="stage" title="Stage file (⌘⇧Y)">+</button><button class="ico" data-act="revert" title="Discard changes (⌘⇧N)">↶</button>`;
      const badge = r.conflicted ? `<span class="badge">conflict</span>` : '';
      return `<div class="row ${selectedKey === key ? 'sel' : ''}" data-key="${esc(key)}" role="button">
        <span class="st ${r.letter === '?' ? 'Q' : r.letter}">${r.letter}</span>
        <span class="path"><span class="dir">${esc(dir)}</span>${esc(name)}</span><span class="tail">${badge}<span class="acts">${acts}</span></span></div>`;
    };
    const sec = (label: string, n: number, all: 'stage' | 'unstage', name: string, hint: string, glyph: string) =>
      `<div class="sec"><span>${label}</span><span class="r"><span class="n">${n}</span>` +
      `<button class="ico" data-all="${all}" title="${name}${hint}" aria-label="${name}" ${n ? '' : 'disabled'}>${glyph}</button></span></div>`;
    this.list.innerHTML =
      sec('Changes', q.unstaged.length, 'stage', 'Stage all changes', ' (⌘⌥Y)', '+') +
      (q.unstaged.length ? q.unstaged.map(rowHtml).join('') : `<div class="empty-sec">Nothing left to review</div>`) +
      sec('Staged', q.staged.length, 'unstage', 'Unstage all changes', '', '−') +
      (q.staged.length ? q.staged.map(rowHtml).join('') : `<div class="empty-sec">Accepted hunks land here</div>`);
    const n = q.staged.length;
    (this.root.querySelector('#commit-btn') as HTMLButtonElement).disabled = n === 0;
    this.root.querySelector('.hint')!.textContent = n ? `${n} file${n > 1 ? 's' : ''} staged` : 'Nothing staged yet';
  }

  focusCommit(): void { this.msg.focus(); }
  focusList(): void { this.list.focus(); }
  message(): string { return this.msg.value.trim(); }
  clearMessage(): void { this.msg.value = ''; }
}
