import type { CSSProperties } from 'react';
import { TOOLS } from '#features/ai-tools';
import type { LimitWindow } from '#ipc/git';
import { LIMIT_PROVIDERS, type LimitProvider } from '#ipc/settings';
import { useApp } from '#kernel/store';
import { Count } from '#ui/Count';
import { Reveal } from '#ui/Reveal';
import { Tip } from '#ui/Tip';
import { agoText, headline, meterWindows, refreshLimit, resetText } from './limits';
import type { Limits } from './state';

const pct = (n: number): string => `${n}%`;

export function LimitsPills() {
  const { limits, limitsBusy, settings } = useApp();
  return (
    <div className="limits">
      {LIMIT_PROVIDERS.map((p) => {
        const l = limits[p];
        return (
          <Reveal key={p} as="span" when={settings[`limits.${p}`] === 'on' && !!l?.windows}>
            {l?.windows && <LimitPill provider={p} limits={l} windows={l.windows} busy={limitsBusy.includes(p)} />}
          </Reveal>
        );
      })}
    </div>
  );
}

function level(percent: number): string {
  if (percent >= 90) return 'high';
  return percent >= 70 ? 'mid' : 'low';
}

const meter = (used: number): CSSProperties => ({ '--used': Math.min(used, 100) / 100 } as CSSProperties);

function LimitPill({ provider, limits, windows, busy }: {
  provider: LimitProvider; limits: Limits; windows: readonly LimitWindow[]; busy: boolean;
}) {
  const tool = TOOLS.find((t) => t.id === provider);
  const name = tool?.name ?? provider;
  // the backend answers with at least one window or an error
  const head = headline(windows);
  if (!head) return null;
  const used = Math.round(head.percent);
  return (
    <Tip label={`${name} usage`} detail={<LimitCard limits={limits} />} align="end">
      <button type="button" className="pill limit-pill" data-provider={provider}
        data-level={level(used)} data-stale={limits.error !== null || undefined} data-busy={busy || undefined}
        aria-label={`${name}: ${used}% used, ${head.label.toLowerCase()} limit`}
        onClick={() => void refreshLimit(provider)}>
        {tool && <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={tool.logo} /></svg>}
        <Count value={used} format={pct} />
        <span className="limit-meters">
          {meterWindows(windows).map((w) => {
            const part = Math.round(w.percent);
            return <span key={w.label} className="limit-meter" data-level={level(part)} style={meter(part)} />;
          })}
        </span>
      </button>
    </Tip>
  );
}

/** Spans only: the tip puts the detail inside a span. */
function LimitCard({ limits }: { limits: Limits }) {
  return (
    <span className="limit-card">
      {(limits.windows ?? []).map((w, i) => {
        const used = Math.round(w.percent);
        const reset = resetText(w);
        return (
          <span key={`${i}:${w.label}`} className="limit-row" data-level={level(used)}>
            <span className="limit-name">{w.label}</span>
            <span className="limit-pct">{used}%</span>
            <span className="limit-meter" style={meter(used)} />
            {reset !== null && <span className="limit-reset">Resets {reset}</span>}
          </span>
        );
      })}
      {limits.error !== null && <span className="limit-error">Could not refresh: {limits.error}</span>}
      <span className="limit-foot">
        {limits.at === null ? 'Click to try again' : `Updated ${agoText(limits.at)} · click to refresh`}
      </span>
    </span>
  );
}
