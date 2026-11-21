# Visual viewport keyboard

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [visual-viewport-keyboard.test.ts](visual-viewport-keyboard.test.ts).

## visual-viewport-keyboard-001

Original test `Repeated mobile keyboard sessions keep an existing-chat composer visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.test.ts#L169).

- **Given** A focused composer is in an existing chat on a standalone mobile app. The visual viewport and inner height are 844px.
- **When** The keyboard opens and closes five times, with viewport height 520px while open and alternating between 740px and 843.4px while closing; the editor is refocused after each cycle if needed.
- **Then** Each open scrolls the composer into view once, reserves 340px, and uses automatic scrolling to the end. Viewport panning alone does not trigger another scroll. Each close clears the keyboard-open marker and scroll reserve, including when the editor remains focused.

## visual-viewport-keyboard-002

Original test `An ordinary mobile browser does not force-scroll the page for the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.test.ts#L219).

- **Given** A focused composer is in an existing chat in an ordinary mobile browser, not a standalone app. The visual viewport and inner height are 844px.
- **When** The visual viewport shrinks to 520px with an offset of 100px.
- **Then** The keyboard is reported open, but the composer is not force-scrolled into view.

## visual-viewport-keyboard-003

Original test `Report each keyboard open and close once to the layout beside it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.test.ts#L233).

- **Given** A focused composer is in an existing chat on a standalone mobile app, with the visual viewport and inner height at 844px.
- **When** The viewport shrinks to 520px, pans while the keyboard remains open, shrinks again to 500px, and then returns to 844px after the editor loses focus.
- **Then** The adjacent layout is notified once when the keyboard opens and once when it closes; panning and the additional resize while open do not produce another notification.
