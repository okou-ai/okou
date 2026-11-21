# Browser viewer binding

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-viewer-binding.test.tsx](browser-viewer-binding.test.tsx).

## browser-viewer-binding-001

Original test `An instance replaced during acquisition uses the viewer response's native window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L96).

- **Given** A browser viewer is being acquired and the lease identifies a replacement browser instance with native window 202.
- **When** The browser page loads and receives the viewer response.
- **Then** The replacement browser connects in native window 202: its replacement page is shown, the sibling window is not shown, and a newly created tab targets window 202. The viewer is requested once.

## browser-viewer-binding-002

Original test `Explicit reconnect waits for a fresh binding before admitting a replacement window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L118).

- **Given** The current browser connection is unavailable, and a reconnect will return a fresh viewer binding for a replacement instance.
- **When** The user selects Reconnect while the fresh viewer request is still pending, then the request is released.
- **Then** Before release, the replacement has not connected and remote browser input remains disabled. After release, the replacement page is shown, its sibling window is excluded, and a new tab targets the replacement window. The viewer is requested twice in total.

Batch 36 retained clause. A Router control kept input disabled during the pending viewer lookup and observed the replacement socket opening only after release. The replacement address became interactive, its sibling was excluded, and the new tab belonged to window 202. The final clause requires an exact count of viewer requests, which docs/app/app-testing.md excludes. This ID remains open.

## browser-viewer-binding-003

Original test `Changing connection mode cancels pending socket opening before reusing the same descriptor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L167).

- **Given** The browser is connecting in the same-window mode, with its socket opening pending and one page in window 101.
- **When** The user switches to Separate image connection, then the pending socket is opened.
- **Then** The browser reaches an interactive state, retains the page at https://example.com, and still has exactly one target.

## browser-viewer-binding-004

Original test `Changing connection mode cancels pending native attachment before reusing the same descriptor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L167).

- **Given** The browser is connecting in the same-window mode, with native attachment pending and one page in window 101.
- **When** The user switches to Separate image connection before the attachment completes.
- **Then** The browser reaches an interactive state, retains the page at https://example.com, and still has exactly one target.

## browser-viewer-binding-005

Original test `A distinct confirmed replacement streams while old bridge cleanup is unacknowledged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L233).

- **Given** The old browser is connected and showing a page; cleanup of its bridge is left unacknowledged after its worker resets.
- **When** A distinct replacement browser becomes available during recovery.
- **Then** The replacement streams an interactive view of its replacement page, excludes its sibling window, and creates a new tab in window 202 while old bridge cleanup remains unacknowledged. The old browser's target remains present.

## browser-viewer-binding-006

Original test `A replacement clears a delayed old creation's blank presentation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx#L277).

- **Given** The connected old browser has a new-tab creation pending; after the request is received, the page shows “Nothing open yet.” The old browser worker then resets and recovery begins.
- **When** A replacement browser becomes available, and the delayed old creation is released afterward.
- **Then** “Nothing open yet” is cleared during recovery and remains absent after replacement. The replacement page is interactive and selected even after the old creation completes.
