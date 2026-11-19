# Chat capability voice draft loading

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-draft-loading.test.tsx](chat-capability-voice-draft-loading.test.tsx).

## chat-capability-voice-draft-loading-001

Original test `Wait for nonempty PCM before showing the waveform and preserve the opening audio`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-draft-loading.test.tsx#L37).

- **Given** Voice input is available, but the connected recorder has produced no audio samples yet.
- **When** The user starts recording, supplies an empty sample batch, then a 4,096-sample batch followed by another 4,096 samples, and stops recording.
- **Then** The starting state remains disabled with no Stop recording control or waveform until the nonempty batch arrives. The waveform then appears, and the uploaded audio contains exactly 8,192 samples in order: the first batch followed by the later audio.
