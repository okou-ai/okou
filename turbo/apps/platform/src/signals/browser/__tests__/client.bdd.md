# Client

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [client.test.ts](client.test.ts).

## client-001

Original test `a version-probe deadline leaves the CDP connection usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L16).

- **Given** A CDP connection is open, but its Browser.getVersion probe receives no response before the 31-second deadline.
- **When** The probe deadline expires and the client makes a Target.getTargets request.
- **Then** The version probe rejects as a read-only protocol failure, while Target.getTargets still succeeds with an empty target list.

## client-002

Original test `closing a viewer rejects pending requests without closing the remote browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L50).

- **Given** A viewer has two pending CDP requests on an open connection to a remote browser.
- **When** The viewer closes and then attempts to notify the browser.
- **Then** Both pending requests reject, and no notification is sent after closing; the remote browser is not closed by this action.

## client-003

Original test `raw native attachment cancellation preserves its original parent session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L77).

- **Given** A native browser attachment is pending on a CDP connection, with its request associated with the original parent session.
- **When** The operation is cancelled, a later Browser.getVersion request is made, and the attachment response arrives late.
- **Then** The attachment request rejects with AbortError, the connection remains usable, and the late attachment is detached using the original parent session.

## client-004

Original test `cancelling native bridge startup releases its late original attachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L135).

- **Given** Native bridge startup has sent a browser-target attachment request on an open CDP connection.
- **When** Startup is cancelled and the attachment response arrives late.
- **Then** Startup rejects with AbortError, the late native attachment is detached, and the connection remains usable for Browser.getVersion.

## client-005

Original test `an ambiguous CDP response rejects its pending request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L179).

- **Given** An open CDP connection receives a response containing both a result and an error for a request.
- **When** The client requests Target.getTargets and then Browser.getVersion.
- **Then** The ambiguous response rejects the first request with “Invalid CDP response.”; the subsequent request rejects as a connection failure.

## client-006

Original test `native events remain private to the originating connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L204).

- **Given** Two CDP clients are open on different connections and listen for native events.
- **When** Two events arrive on the first connection, including one with a session ID shared by both clients, and another event arrives after the first client closes.
- **Then** Only the first client receives the two events received while it was open; the second client receives none, and the closed client receives no later event.

## client-007

Original test `parallel requests keep independent results when replies arrive out of order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L258).

- **Given** Two Page.navigate requests are pending on one CDP connection, each for a different session and destination.
- **When** The second session's reply arrives before the first session's reply.
- **Then** Each request resolves with its own frame ID: second-frame for the second destination and first-frame for the first.

## client-008

Original test `cancelling one request preserves its socket and releases a late original attachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L302).

- **Given** A Target.attachToTarget request is pending for the original page on an open CDP connection.
- **When** That request is cancelled, the connection is used for Browser.getVersion, and the late attachment response arrives.
- **Then** The attachment request rejects with AbortError; the late session is detached, and Browser.getVersion succeeds both before and after the late response.

## client-009

Original test `an already-cancelled request never writes to the native connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L358).

- **Given** A CDP client is open, but the operation signal is already cancelled.
- **When** The client attempts to create a target using that signal, then makes a Browser.getVersion request without it.
- **Then** The cancelled request rejects with AbortError without sending anything; the later version request succeeds.

## client-010

Original test `cancelling one connection rejects its request while another stays usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L391).

- **Given** Two CDP connections are open, and a Target.getTargets request is pending on the first connection.
- **When** The first connection's owning operation is cancelled, then the second connection requests Browser.getVersion.
- **Then** The first request rejects with a connection failure and its connection closes; the second connection remains usable and returns the browser version.

## client-011

Original test `late Runtime objects are released on their original connection and session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L430).

- **Given** A Runtime.evaluate request is pending on one CDP connection and its result includes an object to release; a replacement connection is also open.
- **When** The request is cancelled and its late response arrives.
- **Then** The request rejects with AbortError, and the object is released on the original connection and session, not the replacement connection.

## client-012

Original test `canvas decoding coalesces queued frames and reports only completed draws`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L489).

- **Given** A canvas renderer receives first, superseded, and latest frames while the first frame is still decoding.
- **When** The first and latest decodes complete.
- **Then** Only first and latest are decoded and drawn, each completed draw is reported once, and both decoded frames are closed. The canvas ends at 800 by 600, with no failures.

## client-013

Original test `invalidated decodes are released and admission cannot paint an invalidated frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/browser/__tests__/client.test.ts#L549).

- **Given** A stale frame is decoding when the renderer is invalidated; a current frame is then admitted with a check that invalidates it before painting.
- **When** Both decodes complete.
- **Then** Both decoded frames are closed, neither frame is drawn or reported as painted, and no failure is reported.
