# Chat capability voice recording

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-voice-recording.test.tsx](chat-capability-voice-recording.test.tsx).

## chat-capability-voice-recording-001

Original test `Use committed PCM as a normal recording draft after reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L73).

- **Given** A recording has committed 4,096 audio samples before the page is reloaded.
- **When** The user chooses the restored recording in the new page.
- **Then** The audio is transcribed and polished into “Recovered audio.”, and it is uploaded only once with all 4,096 saved samples, including the final sample value.

## chat-capability-voice-recording-002

Original test `Include the final worklet chunk before transcribing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L138).

- **Given** A recording has 4,096 queued samples and a final worklet chunk of 1,024 samples.
- **When** The user immediately stops recording after the queued samples arrive.
- **Then** Transcription receives all 5,120 samples in order, including the final chunk, and voice input becomes available again.

## chat-capability-voice-recording-003

Original test `Use the completed transcript retained in a recording draft after reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L175).

- **Given** A recording’s transcript “Keep this saved speech.” has completed, but polishing fails with “Editing is busy.” The page is reloaded after the failure.
- **When** Polishing becomes available and the user chooses the restored recording.
- **Then** The saved transcript is polished into the composer without uploading the audio for transcription again.

## chat-capability-voice-recording-004

Original test `Restore 128 completed segments with 1 transcripts per polish item`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L245).

- **Given** A restored recording contains 128 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 128 polish segments with one transcript per item; the audio is not retranscribed.
- **Rebuild note** Not accepted in batch 12. A restored draft with completed transcript segments can only be built publicly by recording and transcribing every 15-second segment. A local probe took about 11 s and 1.2 GB RSS for 64 segments, growing roughly quadratically, so 128 segments would need a raised test timeout, which the project guidance avoids (no timeout increases to absorb local resource cost). Batch 13 docs check: `createTestRuntime(context)` in docs/app/app-testing.md covers the app replacement (reload) that keeps browser storage, but no documented boundary seeds a persisted voice draft, so the segments must still be recorded. Decide whether to retire the case under "Cases Without Public Construction" or accept another public construction.

## chat-capability-voice-recording-005

Original test `Restore 129 completed segments with 2 transcripts per polish item`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L245).

- **Given** A restored recording contains 129 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 65 polish segments with up to two transcripts per item; the audio is not retranscribed.
- **Rebuild note** Not accepted in batch 12. A restored draft with completed transcript segments can only be built publicly by recording and transcribing every 15-second segment. A local probe took about 11 s and 1.2 GB RSS for 64 segments, growing roughly quadratically, so 129 segments would need a raised test timeout, which the project guidance avoids (no timeout increases to absorb local resource cost). Batch 13 docs check: `createTestRuntime(context)` in docs/app/app-testing.md covers the app replacement (reload) that keeps browser storage, but no documented boundary seeds a persisted voice draft, so the segments must still be recorded. Decide whether to retire the case under "Cases Without Public Construction" or accept another public construction.

## chat-capability-voice-recording-006

Original test `Restore 277 completed segments with 3 transcripts per polish item`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx#L245).

- **Given** A restored recording contains 277 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 93 polish segments with up to three transcripts per item; the audio is not retranscribed.
