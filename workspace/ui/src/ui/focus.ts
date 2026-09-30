/** Pass as `onCloseAutoFocus` on a Radix `DropdownMenu.Content` or `ContextMenu.Content`. Both compose this
 *  ahead of their own restore (DropdownMenu to the trigger, ContextMenu to whatever was focused before) and
 *  skip it once this calls `preventDefault()`, which the `.menu` exit keyframe now needs: it keeps the content
 *  mounted for the animation, and a command that focuses something else in that window (opening a terminal,
 *  the commit box) would otherwise lose it to the late restore. */
export function keepFocus(event: Event): void {
  const content = event.currentTarget;
  const active = document.activeElement;
  if (active !== document.body && !(content instanceof Node && content.contains(active))) event.preventDefault();
}

/** Ref for a Radix `DropdownMenu.Content` / `ContextMenu.Content` (and a `Sub.Content`, should one appear):
 *  marks the node `inert` the instant Radix flips its `data-state` to `closed`, through a `MutationObserver`
 *  rather than the `animationstart` the exit keyframe fires, which can lag a frame or more behind that flip.
 *  In that window the content is still mounted and focusable, and Radix's own item pointer handlers
 *  (`onPointerMove`/`onPointerLeave`, `@radix-ui/react-menu`'s `onItemLeave`) call `.focus()` on an item or the
 *  content itself when the pointer crosses it, which steals focus back from whatever a menu command just set. */
export function inertOnClose(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  const check = () => { if (el.dataset.state === 'closed') el.setAttribute('inert', ''); };
  check();
  const mo = new MutationObserver(check);
  mo.observe(el, { attributes: true, attributeFilter: ['data-state'] });
  return () => mo.disconnect();
}

let lastOutside: HTMLElement | null = null;

/** A `Dialog`/`AlertDialog` opened from a menu item, a context menu item or the palette mounts well after
 *  Radix has moved focus into that menu (or after the palette's own input took it), so `document.activeElement`
 *  at mount time is never what the dialog should restore to. Installed once, at import (not lazily on first
 *  `lastFocusOutside` call), so it has seen every focus change by the time anything asks. */
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el instanceof HTMLElement && !el.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) {
    lastOutside = el;
  }
}, true);

/** `Dialog`/`AlertDialog` read this once, at mount (a `useState` lazy initializer), to know what to restore
 *  focus to when they close: the last element focused outside any menu, dialog or alert dialog, or `null` when
 *  nothing outside one has had focus yet (or it is no longer in the document) and closing should leave focus
 *  on `body`, same as opening one from nothing focused at all. */
export function lastFocusOutside(): HTMLElement | null {
  return lastOutside?.isConnected ? lastOutside : null;
}

/** Pass as `onCloseAutoFocus` on a `Dialog`/`AlertDialog` `Content`, with what `lastFocusOutside()` returned at
 *  mount. Radix's own dialog restores focus to its `Trigger`, but these have none, so nothing comes back on
 *  its own; this restores it, unless a command already moved focus elsewhere (not body, not inside the
 *  dialog, `keepFocus`'s own check) or the opener has since left the document, which it then leaves alone. */
export function restoreFocusTo(opener: HTMLElement | null) {
  return (event: Event): void => {
    const content = event.currentTarget;
    const active = document.activeElement;
    event.preventDefault();
    if (active === document.body || (content instanceof Node && content.contains(active))) {
      if (opener?.isConnected) opener.focus();
    }
  };
}
