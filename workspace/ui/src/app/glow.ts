import { useLayoutEffect, useRef } from 'react';
import { buildQueue } from '#core/model';
import { agentOf, terminalsOf } from '#features/terminals';
import type { DeepReadonly, State } from '#kernel/store';
import { type GlowLight, LIGHTS, showGlowScene } from '#ui/glow';

/** A place across the sidebar, as a fraction of its width; the window's left column is 72px. */
const across = (sideW: number) => (f: number) => 72 + sideW * f;

/** The middle of each terminal tile in the activity bar, in px from the window's top, by session id. */
export type Tiles = ReadonlyMap<number, number>;

/** Changes: the diff's own colours along the queue, one bright light at its head. More to review is a fuller
 *  light; an empty queue is a calm one. */
function changes(unstaged: number, side: (f: number) => number): GlowLight[] {
  const load = Math.min(1, unstaged / 6);
  const k = 0.55 + 0.45 * load;
  const r = 0.85 + 0.15 * load;
  return [
    { x: side(0.5), y: '9%', r: 525 * r, color: 'var(--accent)', k: 1.1 * k },
    { x: side(0.2), y: '30%', r: 375 * r, color: 'var(--add)', k },
    { x: side(0.8), y: '48%', r: 350 * r, color: 'var(--del)', k },
    { x: side(0.3), y: '68%', r: 425 * r, color: 'var(--mod)', k },
    { x: side(0.75), y: '92%', r: 450 * r, color: 'var(--hue-purple)', k },
    { x: '30%', y: '0%', r: 260, color: 'var(--hue-yellow)', k: 0.9 },
    { x: '64%', y: '2%', r: 400, color: 'var(--info)', k: 0.9 },
  ];
}

/** Files: cooler, smaller lights in a loose column down the tree. */
function files(side: (f: number) => number): GlowLight[] {
  return [
    { x: side(0.3), y: '14%', r: 240, color: 'var(--info)', k: 0.9 },
    { x: side(0.7), y: '30%', r: 220, color: 'var(--hue-blue)', k: 0.9 },
    { x: side(0.25), y: '46%', r: 200, color: 'var(--hue-purple)', k: 0.9 },
    { x: side(0.7), y: '62%', r: 230, color: 'var(--syn-function)', k: 0.9 },
    { x: side(0.35), y: '80%', r: 210, color: 'var(--hue-blue)', k: 0.9 },
    { x: '22%', y: '0%', r: 350, color: 'var(--ansi-cyan)', k: 0.8 },
    { x: '72%', y: '0%', r: 375, color: 'var(--hue-purple)', k: 0.8 },
  ];
}

/** Terminals: the activity bar and the header are all that is lit, so the lights gather there. Each session's
 *  tile gets a light in its agent's colour, the selected one the brightest; the rest go along the header. */
function terminals(s: DeepReadonly<State>, tiles: Tiles): GlowLight[] {
  const sessions = terminalsOf(s.terminals);
  const color = (i: number) => {
    const agent = sessions[i] && agentOf(sessions[i]);
    return agent ? `var(--agent-${agent})` : 'var(--accent)';
  };
  const lead = sessions.findIndex((t) => t.id === s.activeTerm);
  const lights: GlowLight[] = [];
  const leadY = sessions[lead] && tiles.get(sessions[lead].id);
  if (leadY !== undefined) lights.push({ x: 36, y: leadY, r: 325, color: color(lead), k: 2 });
  sessions.forEach((t, i) => {
    const y = tiles.get(t.id);
    if (i === lead || y === undefined || lights.length >= 4) return;
    lights.push({ x: 36, y, r: 160, color: color(i), k: 0.55 });
  });
  const header = LIGHTS - lights.length;
  for (let i = 0; i < header; i++) {
    lights.push({
      x: `${Math.round(12 + (76 * i) / Math.max(1, header - 1))}%`, y: '0%', r: 375,
      color: sessions.length ? color(i % sessions.length) : 'var(--accent)', k: 0.75,
    });
  }
  return lights;
}

/** Only Animated gives each tab its own scene; Enabled keeps the Changes lights in place on every tab. */
export function sceneFor(s: DeepReadonly<State>, tiles: Tiles): GlowLight[] {
  const side = across(s.sideWidth ?? 272);
  if (s.settings['appearance.glow'] !== 'animated') {
    return changes(s.status ? buildQueue(s.status).unstaged.length : 0, side);
  }
  if (s.tab === 'terminals') return terminals(s, tiles);
  if (s.tab === 'files') return files(side);
  return changes(s.status ? buildQueue(s.status).unstaged.length : 0, side);
}

/** Layout places, not painted ones: a tile that pops in or slides up is measured where it will settle. A tile
 *  that is leaving still has its session's id, and that session is gone from the list, so it is skipped. */
function measureTiles(): Map<number, number> {
  const tiles = new Map<number, number>();
  for (const el of document.querySelectorAll<HTMLElement>('.act [data-term]')) {
    let top = el.offsetHeight / 2;
    for (let at: HTMLElement | null = el; at; at = at.offsetParent as HTMLElement | null) top += at.offsetTop;
    tiles.set(Number(el.dataset.term), Math.round(top));
  }
  return tiles;
}

/** Shows the scene for the current tab. A new tab or a new terminal is a focus pull; anything else that moves the
 *  lights (the queue's count, a tile opening) glides them. */
export function useGlowScene(s: DeepReadonly<State>): void {
  const last = useRef<{ key: string; focus: string } | null>(null);
  const unstaged = s.status ? buildQueue(s.status).unstaged.length : 0;
  const sessions = terminalsOf(s.terminals).map((t) => `${t.id}:${agentOf(t) ?? ''}`).join(',');
  const mode = s.settings['appearance.glow'];
  useLayoutEffect(() => {
    // only the terminals' scene needs the tiles, and reading them costs a layout
    const tiles = s.tab === 'terminals' && mode === 'animated' ? measureTiles() : new Map<number, number>();
    const scene = sceneFor(s, tiles);
    const key = JSON.stringify(scene);
    const focus = `${s.tab}:${s.tab === 'terminals' ? s.activeTerm : ''}`;
    const prev = last.current;
    last.current = { key, focus };
    if (prev?.key === key) return;
    showGlowScene(scene, !prev ? 'cut' : prev.focus !== focus ? 'pull' : 'ease');
  }, [s.tab, s.activeTerm, unstaged, sessions, mode, s.sideWidth]);
}
