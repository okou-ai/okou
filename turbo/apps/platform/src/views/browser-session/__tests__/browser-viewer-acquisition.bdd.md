# Browser viewer acquisition

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-viewer-acquisition.test.tsx](browser-viewer-acquisition.test.tsx).

## browser-viewer-acquisition-001

Original test `An active shared mount uses the acquired connection while other entry points are unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L234).

- **Given** An active shared browser session is available, but explicit browser opening is unavailable.
- **When** The browser page loads and the user enters text into the remote browser input.
- **Then** The acquired connection accepts input, the live view is visible, and the address shows https://owned.example.

## browser-viewer-acquisition-002

Original test `Explicit Start's returned connection enables input while further acquisition is stalled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L242).

- **Given** The browser session is suspended and a browser page is open.
- **When** The user explicitly starts the browser while further connection acquisition is stalled.
- **Then** The connection returned by Start enables input, displays the live view, and shows https://owned.example.

## browser-viewer-acquisition-003

Original test `Start's 1 lifecycle notifications preserve its returned usable connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L252).

- **Given** The browser session is suspended and a browser page is open.
- **When** The user starts the browser and Start triggers one lifecycle notification carrying its operation ID while further acquisition is stalled.
- **Then** The returned connection remains usable for input, the live view is visible, and the address shows https://owned.example.

## browser-viewer-acquisition-004

Original test `Start's 2 lifecycle notifications preserve its returned usable connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L252).

- **Given** The browser session is suspended and a browser page is open.
- **When** The user starts the browser and Start triggers two lifecycle notifications carrying its operation ID while further acquisition is stalled.
- **Then** The returned connection remains usable for input, the live view is visible, and the address shows https://owned.example.

## browser-viewer-acquisition-005

Original test `A late open echo is ignored while another operation still refreshes the viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L274).

- **Given** The browser session is suspended and Start has opened a usable browser connection.
- **When** A late lifecycle notification echoes Start's operation ID while another viewer refresh is held, then a notification with a different operation ID arrives after reads are denied.
- **Then** The first echo preserves the working connection; the later notification displays the chat's browser-disabled message and removes remote browser input.

## browser-viewer-acquisition-006

Original test `An uncorrelated notification during Start still invalidates the acquisition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L301).

- **Given** The browser session is suspended and reads will be denied when Start is used.
- **When** Start triggers a lifecycle notification without an operation ID.
- **Then** The acquisition is invalidated, the browser-disabled message appears, and remote browser input is absent.

## browser-viewer-acquisition-007

Original test `A notification that invalidates Start also retires that operation's echo ID`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L314).

- **Given** The browser session is suspended and reads will be denied when Start is used.
- **When** An uncorrelated lifecycle notification invalidates Start, reads are restored, and a later notification carries Start's operation ID while opening is unavailable.
- **Then** The stale operation ID does not prevent the existing connection from accepting input; the address remains https://owned.example.

## browser-viewer-acquisition-008

Original test `Reconnect uses a fresh connection while explicit opening is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L334).

- **Given** An active shared browser session is available, but explicit browser opening is unavailable.
- **When** The viewer disconnects and reconnects using a replacement connection.
- **Then** The replacement connection accepts input, the live view is visible, and the address shows https://owned.example.

## browser-viewer-acquisition-009

Original test `A renewed grant cannot reuse the previous grant's explicit-open result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-acquisition.test.tsx#L349).

- **Given** The browser session is suspended and authorized; Start opens a usable connection.
- **When** Permission is revoked and renewed, and explicit opening is unavailable after the renewal.
- **Then** The revoked state displays the browser-disabled message, but the renewed grant obtains a replacement usable connection; the address shows https://owned.example.
