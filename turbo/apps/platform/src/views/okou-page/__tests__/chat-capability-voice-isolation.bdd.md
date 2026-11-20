# Chat capability voice isolation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-isolation.test.tsx](chat-capability-voice-isolation.test.tsx).

## chat-capability-voice-isolation-001

Original test `Release a VAD session initialized after the old composer was cancelled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-isolation.test.tsx#L29).

- **Given** A recording has been stopped while its voice-activity model is still loading, and the original composer is cancelled.
- **When** The model finishes loading after a different user opens a new chat.
- **Then** The old voice-activity session is released, and the new composer remains empty with no Use recording control.

## chat-capability-voice-isolation-002

Original test `keep local recordings isolated when the composer changes user > preserves the complete scenario`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-isolation.test.tsx#L113).

- **Given** A user has a failed local recording draft in the composer.
- **When** The composer is replaced by a new session for a different user.
- **Then** Voice input is available in the new composer, and the previous recording is not offered for use.

## chat-capability-voice-isolation-003

Original test `keep local recordings isolated when the composer changes org > preserves the complete scenario`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-isolation.test.tsx#L113).

- **Given** A user has a failed local recording draft in the composer.
- **When** The composer is replaced by a new session in a different organization.
- **Then** Voice input is available in the new composer, and the previous recording is not offered for use.
