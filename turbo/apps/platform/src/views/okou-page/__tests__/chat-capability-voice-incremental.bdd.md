# Chat capability voice incremental

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-incremental.test.tsx](chat-capability-voice-incremental.test.tsx).

## chat-capability-voice-incremental-001

Original test `Keep recording data after an incremental segment fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-incremental.test.tsx#L18).

- **Given** A recording is in progress and an incremental transcription segment fails with a temporary 503 error.
- **When** The user continues recording and then stops.
- **Then** Recording remains available until stopped, the temporary failure message is shown, and a removable voice draft is retained.

## chat-capability-voice-incremental-002

Original test `Preserve audio and retain its draft when transcription is busy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-incremental.test.tsx#L56).

- **Given** A recorded audio file is submitted for transcription and the service responds that speech recognition is temporarily busy.
- **When** The user stops recording.
- **Then** The audio is uploaded once, the busy message is shown, and a removable voice draft is retained.

## chat-capability-voice-incremental-003

Original test `Keep genuine transcription failures actionable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-incremental.test.tsx#L88).

- **Given** A recording is submitted and transcription fails with a 502 configuration error.
- **When** The user stops recording.
- **Then** The configuration failure is shown, a removable voice draft remains, and the exception is reported with its error code and status.
