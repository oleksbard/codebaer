import type { PointerEvent } from 'react';

/** A tip opens on a pointer move that bubbles up from anything inside its trigger. A control inside a row that has
 *  a tip of its own sets this on the element around it, so the row's slower tip does not open over its own. */
export const tipScope = (e: PointerEvent): void => e.stopPropagation();
