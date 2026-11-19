# Chat capability voice input

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-input.test.tsx](chat-capability-voice-input.test.tsx).

## chat-capability-voice-input-001

Original test `Show a recording error when the audio worklet fails to load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L78).

- **Given** Voice input is available, but the audio worklet cannot load.
- **When** The user starts voice input.
- **Then** The app shows “Could not start recording.” and voice input becomes available again.

## chat-capability-voice-input-002

Original test `Start and stop voice input from the focused composer shortcut`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L99).

- **Given** The message composer is focused and voice input is available with the Meta+Shift+E or Control+Shift+E shortcut.
- **When** The user presses the shortcut to start recording, then presses it again to stop.
- **Then** The first press starts recording and prevents the default key action; the second inserts “Shortcut voice note” into the composer and voice input becomes available again.

## chat-capability-voice-input-003

Original test `Transcribe a voice draft with its editor context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L148).

- **Given** The composer contains “Opening closing,” with the caret between the two words, and earlier assistant replies include project context.
- **When** The user records and stops a voice draft whose polished transcript is “Send the launch update tomorrow.”, then moves the caret between “Opening ” and “closing” while transcription is pending.
- **Then** The transcript is inserted at the caret, producing “Opening Send the launch update tomorrow. closing.” The composer retains focus with a collapsed selection, and the user can type “ Additional note.” before “closing.”

## chat-capability-voice-input-004

Original test `Keep a silent voice draft recording until the user stops it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L238).

- **Given** Voice input detects no speech during recording.
- **When** The user stops the silent recording.
- **Then** The app shows “No speech detected. Please record again.”, voice input becomes available again, and the composer remains empty.

## chat-capability-voice-input-005

Original test `Discard a failed recording without removing typed notes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L312).

- **Given** The composer contains “Keep typed notes,” and the voice recording fails to transcribe.
- **When** The user removes the failed voice draft.
- **Then** The voice input control returns and the typed notes remain unchanged.

## chat-capability-voice-input-006

Original test `Finish a provider no-speech response and preserve the input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-input.test.tsx#L317).

- **Given** The composer contains “Keep the existing draft,” and transcription returns HTTP 204 with no speech response.
- **When** The user records and stops, then types “New words.”
- **Then** Voice input becomes available, the original draft remains selected and unchanged, Add is visible, Send is enabled, and typing replaces the selected draft with “New words.”
