import type { CSSProperties } from 'react';
import { Main } from './Main';
import { Overlays } from './Overlays';
import { Footer, Gutter, Header } from './Shell';
import { ActivityBar, Sidebar } from './Sidebar';
import { S, useApp } from './store';

export function App() {
  useApp();
  if (S.fatal) return <div className="fatal">CodeBär needs git on this machine. {S.fatal}</div>;
  const style = S.sideWidth ? ({ '--side-w': `${S.sideWidth}px` } as CSSProperties) : undefined;
  return (
    <>
      <div className={`app${S.sidebarHidden ? ' nosidebar' : ''}`} id="shell" style={style}>
        <Header />
        <ActivityBar />
        <Sidebar />
        <Gutter />
        <Main />
        <Footer />
      </div>
      <Overlays />
    </>
  );
}
