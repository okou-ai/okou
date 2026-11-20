# Chat run mobile

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-mobile.test.tsx](chat-run-mobile.test.tsx).

## chat-run-mobile-001

Original test `Keep mobile chat gestures predictable in the standalone app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-mobile.test.tsx#L78).

- **Given** The standalone app is open on a touch device with an active chat run, and the composer contains a short draft while the on-screen keyboard is open.
- **When** The user swipes upward on the focused composer, then swipes downward on it, refocuses it, and swipes downward on chat history.
- **Then** The upward composer swipe does not dismiss focus; the downward composer swipe and history swipe do dismiss focus. The composer remains present throughout.
