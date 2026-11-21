# Chat browser shutdown

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-browser-shutdown.test.tsx](chat-browser-shutdown.test.tsx).

## chat-browser-shutdown-001

Original test `Closing the sidebar confirms its original key release before same-browser reuse`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L133).

- **Given** The cloud browser sidebar is open with Shift held in the original browser session.
- **When** The user closes the sidebar and reopens the browser before the original Shift release is confirmed.
- **Then** The reopened input stays disabled until the release is confirmed, then becomes enabled without creating another browser connection. The original session receives Shift down followed by Shift up, a later text entry reaches the browser, and no cleanup error is reported.

## chat-browser-shutdown-002

Original test `A silent original key release cannot retain a normally closed browser indefinitely`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L190).

- **Given** The cloud browser sidebar is open with Shift held, and the original key-release confirmation does not arrive.
- **When** The user closes the sidebar and waits for shutdown, then reopens the browser after the shutdown deadline.
- **Then** The sidebar closes and the browser connection eventually reaches zero; cleanup failure is reported because the original release could not be confirmed after the connection closed. The reopened browser still accepts text, and the original session's recorded input includes the Shift down and a Shift up attempt.

## chat-browser-shutdown-003

Original test `Normal shutdown retains an original native key-release rejection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L254).

- **Given** The cloud browser sidebar is open with Shift held, and the native browser rejects the key-release request with code -32001.
- **When** The user closes the sidebar and the browser shuts down.
- **Then** The browser connection reaches zero, the cleanup error retains the native rejection and its code, and the chat message textbox remains enabled.

## chat-browser-shutdown-004

Original test `Normal sidebar close confirms original pointer cleanup independently of capture`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L279).

- **Given** The cloud browser sidebar is open and the user has pressed the left mouse button on the live browser view.
- **When** The user closes the sidebar while capture shutdown is pending.
- **Then** The sidebar closes while the browser connection remains active until the original mouse-release confirmation is released. The final mouse event is a release, and no cleanup error is reported.

## chat-browser-shutdown-005

Original test `Normal sidebar close confirms original composition cleanup independently of capture`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L279).

- **Given** The cloud browser sidebar is open and the user has entered the composing text “preedit” in the remote input.
- **When** The user closes the sidebar while capture shutdown is pending.
- **Then** The sidebar closes while the browser connection remains active until the original composition-cleanup confirmation is released. The final composition event has empty text, and no cleanup error is reported.
