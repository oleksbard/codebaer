import type { CSSProperties } from 'react';
import { Main } from './Main';
import { Terminals } from './Terminals';
import { Overlays } from './Overlays';
import { Gutter, Header } from './Shell';
import { ActivityBar, Sidebar } from './Sidebar';
import { S, useApp } from './store';

export function App() {
  useApp();
  if (S.fatal) return <div className="fatal">CodeBär needs git on this machine. {S.fatal}</div>;
  const style = S.sideWidth ? ({ '--side-w': `${S.sideWidth}px` } as CSSProperties) : undefined;
  const cls = `app${S.sidebarHidden ? ' nosidebar' : ''}${S.tab === 'terminals' ? ' terminals' : ''}`;
  return (
    <>
      <div className={cls} id="shell" style={style}>
        <Header />
        <ActivityBar />
        <div className="frame">
          <Sidebar />
          <Gutter />
          {S.tab === 'terminals' ? <Terminals /> : <Main />}
        </div>
      </div>
      <Overlays />
    </>
  );
}
