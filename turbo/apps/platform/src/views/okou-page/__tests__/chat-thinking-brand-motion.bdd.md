# Chat thinking brand motion

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thinking-brand-motion.test.tsx](chat-thinking-brand-motion.test.tsx).

## chat-thinking-brand-motion-001

Original test `Show the brand thinking artwork during a run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thinking-brand-motion.test.tsx#L18).

- **Given** A chat run is underway after the user submits “Verify event data collection.”
- **When** The assistant is thinking before its run is accepted and completed.
- **Then** The “Thinking...” status appears with decorative brand artwork. After the run is accepted, the Stop control appears; after completion, the assistant reply appears and the Send control returns.
