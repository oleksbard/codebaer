import type { CSSProperties } from 'react';
import { ReviewPane } from '#features/review';
import { Terminals } from '#features/terminals';
import { OverlayHost } from './OverlayHost';
import { Gutter, Header } from './Shell';
import { ActivityBar, Sidebar } from './Sidebar';
import { useApp } from '#kernel/store';

export function App() {
  const s = useApp();
  if (s.fatal) return <div className="fatal">CodeBär needs git on this machine. {s.fatal}</div>;
  const style = s.sideWidth ? ({ '--side-w': `${s.sideWidth}px` } as CSSProperties) : undefined;
  const cls = `app${s.sidebarHidden ? ' nosidebar' : ''}${s.tab === 'terminals' ? ' terminals' : ''}`;
  return (
    <>
      <div className={cls} id="shell" style={style}>
        <Header />
        <ActivityBar />
        <div className="frame">
          <Sidebar />
          <Gutter />
          {s.tab === 'terminals' ? <Terminals /> : <ReviewPane />}
        </div>
      </div>
      <OverlayHost />
    </>
  );
}
