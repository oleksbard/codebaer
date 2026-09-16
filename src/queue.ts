import { rowKey, type Row, type Section } from './model';
import { esc } from './palette';

export type Tab = 'changes' | 'files';
export type QueueHandlers = {
  openRow(row: Row): void;
  openPlain(path: string): void;
  stageFile(path: string): void;
  revertFile(path: string): void;
  unstageFile(path: string): void;
  commit(message: string): void;
  aiMessage(): void;
  setTab(tab: Tab): void;
  stageAll(): void;
  unstageAll(): void;
};

const SPARKLE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6.5 1Q7.1 5.4 11.5 6.5Q7.1 7.6 6.5 12Q5.9 7.6 1.5 6.5Q5.9 5.4 6.5 1z"/><path d="M12.5 9.5Q12.8 11.7 15 12.2Q12.8 12.7 12.5 15Q12.2 12.7 10 12.2Q12.2 11.7 12.5 9.5z"/></svg>';

const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

export class Queue {
  private list: HTMLElement;
  private commitBox: HTMLElement;
  private msg: HTMLTextAreaElement;
  private rows = new Map<string, Row>();
  private open: Record<Section, boolean> = { unstaged: true, staged: true };
  private staged = 0;
  private aiBusy = false;

  constructor(private root: HTMLElement, private h: QueueHandlers) {
    root.innerHTML = `
      <div class="tabs"><button class="tab" data-tab="changes">Changes</button><button class="tab" data-tab="files">Files</button></div>
      <div class="list" tabindex="0"></div>
      <div class="commit">
        <textarea id="commit-message" rows="1" placeholder="Commit message" aria-label="Commit message"></textarea>
        <div class="bar"><span class="hint"></span><span class="r"><button class="ico" id="ai-btn" title="Write the commit message with Claude" aria-label="Write the commit message with Claude" disabled>${SPARKLE}</button><button class="btn primary" id="commit-btn" disabled>Commit <kbd>⌘↩</kbd></button></span></div>
      </div>`;
    this.list = root.querySelector('.list')!;
    this.commitBox = root.querySelector('.commit')!;
    this.msg = root.querySelector('#commit-message')!;
    root.querySelector('.tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
      if (b) h.setTab(b.dataset.tab as Tab);
    });
    root.querySelector('#commit-btn')!.addEventListener('click', () => h.commit(this.message()));
    root.querySelector('#ai-btn')!.addEventListener('click', () => h.aiMessage());
    this.msg.addEventListener('input', () => this.fit());
    this.msg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); h.commit(this.message()); }
    });
    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const all = t.closest('[data-all]') as HTMLElement | null;
      if (all) {
        e.preventDefault();
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
      const sel = this.list.querySelector('details[open] .row.sel') as HTMLElement | null;
      const all = [...this.list.querySelectorAll<HTMLElement>('details[open] .row')];
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
    this.fit();
    this.rows.clear();
    for (const d of this.list.querySelectorAll<HTMLDetailsElement>('details[data-sec]')) this.open[d.dataset.sec as Section] = d.open;
    if (tab === 'files') {
      const dirs = new Map<string, string[]>();
      for (const p of files) { const [d] = split(p); (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(p); }
      this.list.innerHTML = [...dirs.keys()].sort().map((d) =>
        `<details open><summary class="sec d"><span class="l">${esc(d || '/')}</span></summary>${dirs.get(d)!.map((p) =>
          `<div class="row f ${selectedKey === `plain:${p}` ? 'sel' : ''}" data-key="plain:${esc(p)}" data-path="${esc(p)}" data-plain><span class="path"><span class="name">${esc(split(p)[1])}</span></span></div>`).join('')}</details>`).join('');
      return;
    }
    const rowHtml = (r: Row) => {
      const key = rowKey(r);
      this.rows.set(key, r);
      const [dirSlash, name] = split(r.path);
      const acts = r.section === 'staged'
        ? `<button class="ico" data-act="unstage" title="Unstage file">−</button>`
        : r.conflicted
          ? `<button class="ico" data-act="stage" title="Mark resolved">+</button>`
          : `<button class="ico" data-act="stage" title="Stage file (⌘⇧Y)">+</button><button class="ico" data-act="revert" title="Discard changes (⌘⇧N)">↶</button>`;
      const badge = r.conflicted ? `<span class="badge">conflict</span>` : '';
      return `<div class="row ${selectedKey === key ? 'sel' : ''}" data-key="${esc(key)}" data-st="${esc(r.letter)}" role="button" title="${esc(r.path)}">
        <span class="path"><span class="name">${esc(name)}</span><span class="dir">${esc(dirSlash.slice(0, -1))}</span></span>
        <span class="tail">${badge}<span class="acts">${acts}</span><span class="st">${esc(r.letter)}</span></span></div>`;
    };
    const sec = (id: Section, label: string, rows: Row[], empty: string, all: 'stage' | 'unstage', name: string, hint: string, glyph: string) =>
      `<details data-sec="${id}" ${this.open[id] ? 'open' : ''}><summary class="sec"><span class="l">${label}</span><span class="r">` +
      `<button class="ico" data-all="${all}" title="${name}${hint}" aria-label="${name}" ${rows.length ? '' : 'disabled'}>${glyph}</button><span class="n">${rows.length}</span></span></summary>` +
      (rows.length ? rows.map(rowHtml).join('') : `<div class="empty-sec">${empty}</div>`) + `</details>`;
    this.list.innerHTML =
      sec('unstaged', 'Changes', q.unstaged, 'Nothing left to review', 'stage', 'Stage all changes', ' (⌘⌥Y)', '+') +
      sec('staged', 'Staged', q.staged, 'Accepted hunks land here', 'unstage', 'Unstage all changes', '', '−');
    const n = q.staged.length;
    (this.root.querySelector('#commit-btn') as HTMLButtonElement).disabled = n === 0;
    this.staged = n;
    this.updateAi();
    this.root.querySelector('.hint')!.textContent = n ? `${n} file${n > 1 ? 's' : ''} staged` : 'Nothing staged yet';
  }

  focusCommit(): void { this.msg.focus(); }
  focusList(): void { this.list.focus(); }
  message(): string { return this.msg.value.trim(); }
  clearMessage(): void { this.msg.value = ''; this.fit(); }
  setMessage(text: string): void { this.msg.value = text; this.fit(); }
  setAiBusy(on: boolean): void { this.aiBusy = on; this.root.querySelector('#ai-btn')!.classList.toggle('busy', on); this.updateAi(); }
  private fit(): void {
    if (this.commitBox.hidden) return;
    this.msg.style.height = 'auto';
    this.msg.style.height = `${this.msg.scrollHeight + this.msg.offsetHeight - this.msg.clientHeight}px`;
  }
  private updateAi(): void { (this.root.querySelector('#ai-btn') as HTMLButtonElement).disabled = this.staged === 0 || this.aiBusy; }
}
