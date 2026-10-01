import type { CSSProperties } from 'react';
import { NoGit, NoRepo } from '#features/repos';
import { AllChanges, allChangesShown, ReviewPane } from '#features/review';
import { Terminals } from '#features/terminals';
import { OverlayHost } from './OverlayHost';
import { Gutter, Header, SideHandle } from './Shell';
import { useGlowScene } from './glow';
import { ActivityBar, Sidebar } from './Sidebar';
import { useApp } from '#kernel/store';

export function App() {
  const s = useApp();
  useGlowScene(s);
  const style = s.sideWidth ? ({ '--side-w': `${s.sideWidth}px` } as CSSProperties) : undefined;
  const cls = `app glow${s.sidebarHidden ? ' nosidebar' : ''}${s.sideCollapsed ? ' sidecollapsed' : ''}`
    + (s.tab === 'terminals' ? ' terminals' : '');
  return (
    <>
      <div className={cls} id="shell" style={style}>
        <Header />
        <ActivityBar />
        <div className="frame">
          <Sidebar />
          <Gutter />
          {s.tab !== 'terminals' && <SideHandle />}
          {s.tab === 'terminals' ? <Terminals />
            : s.root === null && !s.starting ? <NoRepo />
              : s.folderOnly ? <NoGit />
                : allChangesShown(s) ? <AllChanges /> : <ReviewPane />}
        </div>
      </div>
      <OverlayHost />
    </>
  );
}
