# Session output stream

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [session-output-stream.test.ts](session-output-stream.test.ts).

## session-output-stream-001

Original test `A run change during channel attachment keeps only the latest run subscribed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/chat-page/__tests__/session-output-stream.test.ts#L101).

- **Given** A thread's first run is subscribed while attachment to its output channel is pending.
- **When** A completed event for that run and a prompt for a second run arrive before the first attachment completes.
- **Then** Only the second run remains subscribed; the first run is not subscribed. Ending the viewer lifetime removes the second subscription.

## session-output-stream-002

Original test `Cancelling an obsolete viewer cannot stop its replacement subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/chat-page/__tests__/session-output-stream.test.ts#L163).

- **Given** An obsolete viewer's attachment to the first run's channel is pending while a replacement viewer subscribes to the second run.
- **When** The obsolete viewer is cancelled and its delayed attachment completes.
- **Then** The first run is not subscribed, and the replacement's second-run subscription remains active until its viewer is cancelled.
