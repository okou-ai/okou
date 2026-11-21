# Voice draft audio

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [voice-draft-audio.test.ts](voice-draft-audio.test.ts).

## voice-draft-audio-001

Original test `voice draft segment boundaries > slice 239999 samples after 0 (finished: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A voice draft contains 239,999 samples, with no prior samples segmented.
- **When** The next segment is requested before recording is finished.
- **Then** No segment is returned.

## voice-draft-audio-002

Original test `voice draft segment boundaries > slice 240000 samples after 0 (finished: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A voice draft contains 240,000 samples, with no prior samples segmented.
- **When** The next segment is requested before recording is finished.
- **Then** A non-final segment covers samples 0 through 240,000.

## voice-draft-audio-003

Original test `voice draft segment boundaries > slice 447999 samples after 240000 (finished: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A voice draft contains 447,999 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested before recording is finished.
- **Then** No segment is returned.

## voice-draft-audio-004

Original test `voice draft segment boundaries > slice 448000 samples after 240000 (finished: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A voice draft contains 448,000 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested before recording is finished.
- **Then** A non-final segment covers samples 208,000 through 448,000, retaining a 32,000-sample overlap.

## voice-draft-audio-005

Original test `voice draft segment boundaries > slice 16000 samples after 0 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 16,000 samples, with no prior samples segmented.
- **When** The next segment is requested.
- **Then** A final segment covers samples 0 through 16,000.

## voice-draft-audio-006

Original test `voice draft segment boundaries > slice 240000 samples after 0 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 240,000 samples, with no prior samples segmented.
- **When** The next segment is requested.
- **Then** A final segment covers samples 0 through 240,000.

## voice-draft-audio-007

Original test `voice draft segment boundaries > slice 448000 samples after 240000 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 448,000 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested.
- **Then** A final segment covers samples 208,000 through 448,000, retaining a 32,000-sample overlap.

## voice-draft-audio-008

Original test `voice draft segment boundaries > slice 256000 samples after 240000 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 256,000 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested.
- **Then** A final segment covers samples 208,000 through 256,000, retaining a 32,000-sample overlap.

## voice-draft-audio-009

Original test `voice draft segment boundaries > slice 240001 samples after 240000 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 240,001 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested.
- **Then** A final segment covers samples 208,000 through 240,001, retaining a 32,000-sample overlap.

## voice-draft-audio-010

Original test `voice draft segment boundaries > slice 0 samples after 0 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains no samples, with no prior samples segmented.
- **When** The next segment is requested.
- **Then** No segment is returned.

## voice-draft-audio-011

Original test `voice draft segment boundaries > slice 240000 samples after 240000 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 240,000 samples, and segmentation previously ended at sample 240,000.
- **When** The next segment is requested.
- **Then** No segment is returned.

## voice-draft-audio-012

Original test `voice draft segment boundaries > slice 448000 samples after 448000 (finished: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A finished voice draft contains 448,000 samples, and segmentation previously ended at sample 448,000.
- **When** The next segment is requested.
- **Then** No segment is returned.

## voice-draft-audio-013

Original test `voice draft segment boundaries > slice 1168000 samples after 960000 (finished: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L67).

- **Given** A voice draft contains 73 seconds of samples after recovery, with a retained checkpoint at 60 seconds.
- **When** The next segment is requested before recording is finished.
- **Then** A non-final segment covers samples 58 through 73 seconds; the retained 60-second checkpoint is not resliced.

## voice-draft-audio-014

Original test `voice draft segment boundaries > drains full windows and a stopped tail with two-second overlap`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L76).

- **Given** A finished voice draft contains 42 seconds of samples, and no samples have yet been segmented.
- **When** Segments are requested repeatedly until none remain.
- **Then** The segments cover 0–15, 13–28, 26–41, and 39–42 seconds. Each segment is at most 15 seconds, each end advances beyond the previous end, the overlap is two seconds, and the last segment is final.

## voice-draft-audio-015

Original test `voice draft PCM WAV > round-trips the AudioWorklet sample format`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts#L103). · **intent review**

- **Given** AudioWorklet sample data contains -1, -0.25, 0, 0.25, and 1.
- **When** The samples are encoded as WAV and decoded.
- **Then** The encoded file has audio/wav type, and the decoded samples match the input values within four decimal places.
