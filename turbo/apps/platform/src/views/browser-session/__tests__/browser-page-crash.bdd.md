# Browser page crash

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-page-crash.test.tsx](browser-page-crash.test.tsx).

## browser-page-crash-001

Original test `A retained page crash (session) requires explicit reload and keeps its window connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L115).

- **Given** Two tabs are open and the selected tab has a live view.
- **When** The selected tab crashes and reports the crash on its page session. The user explicitly chooses Reload.
- **Then** The view remains unavailable until Reload, stale images cannot revive it, and recovery reuses the window connection. Late crash notices do not disable the recovered page.

## browser-page-crash-002

Original test `A retained page crash (target) requires explicit reload and keeps its window connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L115).

- **Given** Two tabs are open and the selected tab has a live view.
- **When** The browser reports a crash for the selected tab. The user explicitly chooses Reload.
- **Then** The view remains unavailable until Reload, stale images cannot revive it, and recovery reuses the window connection. Late crash notices do not disable the recovered page.

## browser-page-crash-003

Original test `A retained page crash (split frames) requires explicit reload and keeps its window connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L115).

- **Given** The selected tab uses a separate image connection.
- **When** The image connection reports a crash. The user explicitly chooses Reload.
- **Then** The view stays unavailable until Reload, stale images do not revive it, and the recovered tab keeps its window connection and can navigate.

## browser-page-crash-004

Original test `A page already crashed at attachment admission remains reloadable without retiring the connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L191).

- **Given** The browser's selected tab is already crashed when the viewer opens.
- **When** The user chooses Reload from the unavailable page.
- **Then** The selected tab recovers on the same connection and accepts navigation.

## browser-page-crash-005

Original test `A crash while page initialization is pending cancels its reads and exposes recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L201).

- **Given** The selected tab has not completed its first page read.
- **When** The tab crashes and the user reloads it before the late read returns.
- **Then** The unavailable view offers recovery. Reload restores navigation over the same connection, and the old read does not displace the recovered page.

## browser-page-crash-006

Original test `An unrelated page or session crash leaves the selected page usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L219).

- **Given** The selected page is usable.
- **When** A different page crashes and an unrelated session reports a crash.
- **Then** The selected page can still navigate without opening a new connection.

## browser-page-crash-007

Original test `A crash waits for the original input receipt before the user's reload and never replays text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L229).

- **Given** Text entry was sent to the selected page but has not been acknowledged.
- **When** The page crashes and the user chooses Reload while the input receipt is pending.
- **Then** Reload waits for the original receipt and then recovers the page once, without sending the text again.

## browser-page-crash-008

Original test `A failed original input receipt still fences the crashed tab while a healthy sibling works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L274).

- **Given** The browser has an outstanding text input and another healthy tab.
- **When** The selected page crashes, the input fails, and the user tries Reload before switching tabs.
- **Then** The crashed page reports the failed action without reloading. The healthy tab remains usable on the same connection and does not inherit the message.

## browser-page-crash-009

Original test `A crash cannot substitute for a missing capture-stop or detachment receipt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L313).

- **Given** The selected page crashes while stopping its old picture could not be confirmed.
- **When** The user chooses Reload before and after the old page attachment is confirmed closed.
- **Then** The first attempt reports an error without reloading. The second restores the page and allows navigation.

## browser-page-crash-010

Original test `Changing tabs during crash recovery (Target.attachToTarget) preserves the successor and does not replay reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L339).

- **Given** The user has started Reload on a crashed tab and reattachment is still pending.
- **When** The user selects a healthy sibling before the attachment reply arrives.
- **Then** The healthy sibling stays usable on the same connection when the old reply arrives, and Reload is never sent for the abandoned tab.

## browser-page-crash-011

Original test `Changing tabs during crash recovery (Page.reload) preserves the successor and does not replay reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L339).

- **Given** The user has started Reload on a crashed tab and its reload reply is still pending.
- **When** The user selects a healthy sibling before the reload reply arrives.
- **Then** The sibling stays usable on the same connection, and the original Reload is not replayed after its reply.

## browser-page-crash-012

Original test `A rejected reload stays unavailable without carrying its error into another crashed tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L365).

- **Given** The selected tab is crashed and another tab is healthy.
- **When** The first tab's Reload is rejected, then the user switches to the other tab and that tab crashes.
- **Then** The first tab stays unavailable with local feedback. The sibling has its own clean recovery state and can reload and navigate.

## browser-page-crash-013

Original test `Hiding the viewer cancels a pending crash reload even if visibility returns before its reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L398).

- **Given** The user has chosen Reload for a crashed tab and recovery is awaiting a connection reply.
- **When** The viewer becomes hidden and visible again before the reply arrives.
- **Then** Viewing pauses and returns to the unavailable page. The late reply does not trigger Reload, and a fresh user request recovers on the same connection.

## browser-page-crash-014

Original test `Closing a sibling tab preserves the selected crashed page's Reload action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L430).

- **Given** The selected tab has crashed and another tab is open.
- **When** The user closes the other tab and chooses Reload on the crashed page.
- **Then** The sibling disappears, the selected page retains its Reload action, and successful recovery restores navigation on the same connection.

## browser-page-crash-015

Original test `A renderer crash during a rejected tab close remains unavailable until explicit recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.test.tsx#L451).

- **Given** The user has requested to close the selected tab and the request is pending.
- **When** The tab crashes and the close request is rejected.
- **Then** Input stays disabled and the view remains unavailable. An explicit Reload restores the tab and navigation on the same connection.
