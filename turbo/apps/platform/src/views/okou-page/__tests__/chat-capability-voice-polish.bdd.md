# Chat capability voice polish

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-polish.test.tsx](chat-capability-voice-polish.test.tsx).

## chat-capability-voice-polish-001

Original test `Apply VAD to the new audio of a one-second tail: silent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-polish.test.tsx#L26).

- **Given** A recording contains earlier speech and a final one-second audio tail with zero signal; the tail’s voice-activity probability is 0.9.
- **When** The user stops recording.
- **Then** The silent tail is excluded from polishing, so the composer contains only “Earlier speech.”

## chat-capability-voice-polish-002

Original test `Apply VAD to the new audio of a one-second tail: a short uncertain word`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-polish.test.tsx#L26).

- **Given** A recording contains earlier speech and a final one-second audio tail with signal level 0.1; the tail’s voice-activity probability is 0.2.
- **When** The user stops recording.
- **Then** The short uncertain tail is included in polishing, so the composer contains “Earlier speech. Tomorrow.”
