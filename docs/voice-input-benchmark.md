# Voice input v2 model benchmark

Use one deployed PR App/API commit, one ordinary test organization, and a fixed
audio corpus. Enable `_debug` at `/_/lab`, then choose **Voice
input model** in **Settings → Debug**. The selection is a per-member preference
scoped to the current organization. An unset preference or **Default** uses
Gemini 3.1 Flash-Lite (`google/gemini-3.1-flash-lite`); choosing **Default** clears
the saved preference. Changing the Debug switch only controls access to the
settings and timing diagnostics; a saved model preference remains effective.

Voice transcription and polish are available to all signed-in users in an
organization, subject to the existing audio-input quota. The separate staff
authorization for cancelling global model-provider cooldowns is an operational
permission, not a voice-input prerequisite.

## Model paths

The catalog was checked on 2026-09-06 against the provider APIs and documentation.
Gemini 3.8 Flash was the latest Gemini 3.x Flash in that catalog. Names in the
picker refer to explicit model IDs; record the date and upstream response IDs
as well, since providers can update an endpoint behind an existing ID.

| Models                                                           | Provider path                           | Processing                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini 2.5 Flash-Lite, 3.1 Flash-Lite, 3.6 Flash, 3.8 Flash      | OpenRouter chat completions             | 60-second segments with 2-second overlap, transcribed serially with saved context; final audio and complete-recording polish share one call                                      |
| OpenAI GPT Audio, GPT Audio Mini                                 | OpenRouter chat completions             | Serial 60-second overlapping segments; final audio and polish share one call. Text-only finalization uses Gemini 3.1 Flash-Lite. JSON is prompt-constrained and server-validated |
| Qwen3 ASR Flash, ASR 1.7B, ASR 0.6B                              | OpenRouter audio transcriptions         | Selected ASR transcribes each segment; Gemini 3.1 Flash-Lite reconciles overlap with saved speech and polishes on the final segment                                              |
| OpenAI GPT Transcribe, GPT-4o Transcribe, GPT-4o Mini Transcribe | OpenRouter audio transcriptions         | Selected ASR transcribes each segment; Gemini 3.1 Flash-Lite reconciles overlap with saved speech and polishes on the final segment                                              |
| ElevenLabs Scribe v2                                             | fal synchronous speech-to-text endpoint | Selected ASR transcribes each segment; Gemini 3.1 Flash-Lite reconciles overlap with saved speech and polishes on the final segment                                              |

The API uses its existing `OPENROUTER_API_KEY` and, for Scribe, `FAL_KEY`.
Unavailable credentials or provider errors produce an explicit failure; a
comparison never silently changes to another transcription model. The existing
audio-input quota, duration limits, and successful-use accounting still apply.

GPT Audio's pure-text polish requests returned upstream HTTP 400 during the
YouTube pilot. Finalization with no remaining audio therefore selects the shared
Gemini text model. When a final audio segment remains, GPT Audio transcribes it
and polishes the complete recording in one call.
Debug headers report both models. Short GPT Audio requests keep their combined
audio-based path.

The historical YouTube pilot in [PR #31982](https://github.com/vm0-ai/vm0/pull/31982)
used Gemini 3.6 Flash as its default and shared text-polish model. Its recorded
commits, model IDs, and results describe that configuration; the current default
change does not revise those measurements or rerun that benchmark.

## Corpus

Keep the original audio, its SHA-256 hash, YouTube URL, exact start/end timestamps,
language, reference transcript, transcript source, and any manual corrections.
Human-review YouTube captions before treating them as ground truth. Preserve
numbers, negation, named entities, hesitations, and language switches in the raw
reference; keep any polished reference separate. Never pass a reference answer
to the model as conversation context.

Use an empty composer and no previous assistant message for the baseline corpus.
Test contextual recognition separately, recording the exact assistant message
and editor text before, inside, and after the insertion/selection range. Keep
that context identical across models and preserve the deployed light-polish
prompt version in the experiment record.

Cover English, Chinese, mixed-language speech, numbers and identifiers, background
noise, pauses, silence, and recordings on both sides of the 60-second segment
boundary. Check cuts at 60, 118, and 176 seconds, including a stop exactly at a
cut and a fractional-second tail. V2 no longer loads a VAD model or WASM. Each
new segment includes up to two seconds of preceding audio, but saved recording
time and usage exclude this repeated interval. Keep each test within the current 300-second request limit. Normalize
the replay fixture once so every model receives the same audio:

```sh
ffmpeg -i source.wav -ac 1 -ar 16000 -c:a pcm_s16le fixture.wav
sha256sum fixture.wav
```

## Browser replay

Launch a dedicated local Chromium session with a fixed PCM WAV microphone:

```sh
agent-browser --session voice-benchmark --executable-path /usr/bin/chromium \
  --args "--use-fake-ui-for-media-stream,--use-fake-device-for-media-stream,--use-file-for-fake-audio-capture=/absolute/path/fixture.wav%noloop" \
  open '<actual PR App URL>'
```

Use the App/API origins from the deployment checks. Complete test sign-in and
onboarding, enable the Debug switch, and verify the selected model survives a
reload. Drive the real record and stop controls. Capture microphone activation,
the recording stop action, outgoing audio, response, and editable composer text.
Use a known leading silence interval and align replay to capture readiness so
startup latency cannot truncate the same fixture differently between samples.
Verify the uploaded audio and duration before accepting a sample. Start a fresh
capture for every sample and verify file playback restarts. Do not mock the
transcription API or replace the application's recording/storage code.

## Measurements

With `_debug` enabled, transcription responses include:

- `X-Voice-Input-Model`: the configured transcription model ID.
- `X-Voice-Polish-Model`: the configured polish model ID.
- `Server-Timing`: `voice_segment`, with the duration of the segment request
  including any final polish, in milliseconds.

Measure the serial chain through the final response as well as each request. Timings include
audio preparation at that phase and upstream network time. These headers do not
change the existing response body. Failed requests and 204 no-speech responses
must remain in the results with their status. A provider may still change its
internal routing; these headers report the configured IDs, not a claimed
provider-internal model snapshot.

Record three separate outcomes:

1. End-to-end latency from the stop action to editable text, plus API total and
   provider phase timings. Measure first-use and warmed samples separately.
2. Raw transcription accuracy: English WER, Chinese CER, mixed-language scoring
   with a documented tokenizer, and number/entity/negation preservation.
3. Polished output quality: meaning preservation, corrections, punctuation,
   omissions, and invented content. Do not treat faithful paraphrasing as a raw
   transcription error.

Rotate model order across repetitions to reduce provider-load/time bias. Start
with a small corpus to validate the experiment, then collect enough repetitions
for distributions. Report sample count, successes, failures, mean, P50, P90,
P95, and max; small pilots must not be presented as reliable tail estimates.
Track provider usage/cost separately where available, including the additional
polish call for dedicated STT models. Do not infer provider cost from latency.

Keep CPU/Chrome profiling in a separate pass. Browser replay measures the
software path; real microphone hardware, acoustic echo and device-specific
processing need a separate device test. Sanitize cookies, authorization tokens,
preview-bypass secrets and account identifiers before sharing recordings or
network evidence.

## Sources

- [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models)
- [OpenRouter audio-input models](https://openrouter.ai/api/v1/models)
- [OpenRouter transcription models](https://openrouter.ai/api/v1/models?output_modalities=transcription)
- [OpenRouter STT request and response contract](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [GPT Audio capabilities](https://developers.openai.com/api/docs/models/gpt-audio)
- [ElevenLabs Scribe v2 on fal](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2/api)
