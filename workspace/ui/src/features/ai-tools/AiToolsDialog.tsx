import { useEffect, useState, type ReactNode } from 'react';
import { useApp, type DeepReadonly } from '#kernel/store';
import { Button } from '#ui/Button';
import { Dialog } from '#ui/Dialog';
import { CHECK, StrokeIcon } from '#ui/Icon';
import { Spinner } from '#ui/Spinner';
import { useLatest } from '#ui/useLatest';
import { checkAgain, closeAiTools, copyInstall, openGuide } from './actions';
import { TOOLS, type Tool } from './catalog';
import type { AiTools } from './state';

const COPY = 'M5.5 5.5h7v7h-7zM10.5 3.5h-7v7';
const EXTERNAL = 'M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5h3';
const COPIED_MS = 1500;

/** While the first check runs the only control is Close, which Radix would focus; the dialog itself takes it
 *  instead, and Tab goes on to the cards once they are there. */
function focusDialog(e: Event): void {
  e.preventDefault();
  (e.currentTarget as HTMLElement | null)?.focus();
}

/** A card fits about 35 characters of a command, so a line may also break after a slash of the URL's path,
 *  which splits it at a path segment rather than inside a word. */
function breakable(command: string): ReactNode[] {
  return command.split(/(?<=[^/]\/)(?!\/)/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

function ToolCard({ tool, installed }: { tool: Tool; installed: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => setCopied(await copyInstall(tool));

  return (
    <li className={installed ? 'ai-tool installed' : 'ai-tool'} data-tool={tool.id}>
      <div className="ai-tool-head">
        <span className="ai-tool-logo">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={tool.logo} /></svg>
        </span>
        <div className="ai-tool-title">
          <h3>{tool.name}</h3>
          <span className="ai-tool-meta">{tool.openSource ? `${tool.vendor} · Open source` : tool.vendor}</span>
        </div>
      </div>
      <p className="ai-tool-blurb">{tool.blurb}</p>
      {installed
        ? <p className="ai-tool-installed"><StrokeIcon d={CHECK} size={13} />Installed</p>
        : (
            <>
              <code className="ai-tool-command">{breakable(tool.install)}</code>
              <div className="ai-tool-actions">
                <Button className="ai-tool-copy" aria-label={`Copy the ${tool.name} install command`}
                  onClick={() => void copy()}>
                  <StrokeIcon d={copied ? CHECK : COPY} size={13} />{copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" className="ai-tool-get" aria-label={`${tool.name} install guide`}
                  onClick={() => void openGuide(tool)}>
                  Install guide<StrokeIcon d={EXTERNAL} size={13} />
                </Button>
              </div>
              <span className="sr-only" role="status">{copied ? `Copied the ${tool.name} install command` : ''}</span>
            </>
          )}
    </li>
  );
}

/** Sized like a card, so the dialog keeps its height when the check answers. */
function Placeholder() {
  return (
    <li className="ai-tool placeholder" aria-hidden="true">
      <div className="ai-tool-head">
        <span className="ai-tool-logo" />
        <div className="ai-tool-title"><span className="bar" /><span className="bar short" /></div>
      </div>
      <div className="ai-tool-blurb">
        <span className="bar" /><span className="bar" /><span className="bar short" />
      </div>
      <span className="bar command" />
      <span className="bar action" />
    </li>
  );
}

export function AiToolsOverlay() {
  const s = useApp();
  // the store field is already null while this exits: the last check it had is what it fades out showing
  const tools = useLatest(s.aiTools);
  return tools ? <AiToolsDialog tools={tools} /> : null;
}

function AiToolsDialog({ tools: { installed, checking, failed } }: { tools: DeepReadonly<AiTools> }) {
  useEffect(() => {
    globalThis.addEventListener('focus', checkAgain);
    return () => globalThis.removeEventListener('focus', checkAgain);
  }, []);

  const has = (t: Tool) => installed?.includes(t.id) ?? false;
  const ordered = [...TOOLS.filter((t) => !has(t)), ...TOOLS.filter(has)];
  const body = installed === null && !failed
    ? (
        <>
          <p className="sr-only" role="status">Checking what is installed…</p>
          <ul className="ai-tools-grid">{TOOLS.map((t) => <Placeholder key={t.id} />)}</ul>
        </>
      )
    : (
        <>
          {failed && (
            <div className="ai-tools-note" role="status">
              <span>Could not check which tools are installed.</span>
              {/* not disabled while it checks, which would drop the focus; a second press is ignored */}
              <Button busy={checking} aria-busy={checking} onClick={checkAgain}>
                {checking && <Spinner />}Try again
              </Button>
            </div>
          )}
          <ul className="ai-tools-grid">{ordered.map((t) => <ToolCard key={t.id} tool={t} installed={has(t)} />)}</ul>
        </>
      );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeAiTools(); }} title="AI coding tools"
      className="ai-tools" onOpenAutoFocus={focusDialog}>
      <div className="ai-tools-head">
        {/* the dialog is already named by its hidden title */}
        <h2 className="dialog-title" aria-hidden="true">AI coding tools</h2>
        <p>Coding agents for the terminal.</p>
      </div>
      <div className="ai-tools-body">{body}</div>
    </Dialog>
  );
}
