# voice-io-transcribe

## voice-io-transcribe-001

- Vitest: "voice input routing and reference context > maximum-size voice upload > accepts 25 MiB WAV with a base64-expanded native payload"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. The audio is a 25 MiB WAV file containing 75 seconds of PCM padded with a trailing JUNK chunk, and Google returns the transcript "Recorded speech." in English.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the WAV file, an empty previous transcript and a total duration of 75 seconds.
- Then: The API responds with HTTP 200 and exactly `{ transcript: "Recorded speech.", language: "en" }`. The Google request is sent as `application/json` with a body larger than the base64-expanded size of the WAV file.

## voice-io-transcribe-002

- Vitest: "voice input routing and reference context > rejects uploads above 25 MiB before any provider request"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with an audio file of 25 MiB plus one byte and a total duration of 75 seconds.
- Then: The API responds with HTTP 400 and the error message "Audio files are too large (max 25 MB)".

## voice-io-transcribe-003

- Vitest: "voice input routing and reference context > rejects unusable native candidates without retry: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"},\"candidates\":[]}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns a response whose prompt is blocked for `SAFETY` with no candidates.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and Google is called exactly once, with no retry.

## voice-io-transcribe-004

- Vitest: "voice input routing and reference context > rejects unusable native candidates without retry: {\"candidates\":[{\"finishReason\":\"MAX_TOKENS\",\"content\":{\"parts\":[{\"text\":\"truncated\"}]}}]}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns a candidate truncated with finish reason `MAX_TOKENS`.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and Google is called exactly once, with no retry.

## voice-io-transcribe-005

- Vitest: "voice input routing and reference context > rejects unusable native candidates without retry: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"text\":\"thinking only\",\"thought\":true}]}}]}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns a STOP candidate whose only part is thought text.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and Google is called exactly once, with no retry.

## voice-io-transcribe-006

- Vitest: "voice input routing and reference context > ignores thought parts and rejects an oversized native response"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google first returns a STOP candidate with a private thought part followed by the transcript "Hello.", and later returns a raw body larger than 1 MiB.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file once for each Google response.
- Then: The first request returns HTTP 200 with the transcript "Hello." and without the thought text. The second request returns HTTP 502.

## voice-io-transcribe-007

- Vitest: "voice input routing and reference context > routes voice input to Gemini 3.1 Flash-Lite on Vertex"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and the Okou debug feature switch enabled. Google voice credentials resolve to a Google access token and Google returns the transcript "Ship on Monday.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 200, the transcript "Ship on Monday.", and a `Server-Timing` header containing `voice_segment;dur=`. Google is called once at the `aiplatform.us.rep.googleapis.com` `us` location for model `gemini-3.1-flash-lite:generateContent` with the Google bearer token, `MINIMAL` thinking, temperature 0, 4096 max output tokens, a JSON response MIME type and a schema requiring `transcript` and `language`.

## voice-io-transcribe-008

- Vitest: "voice input routing and reference context > transcribes a 0.56-second recording without polishing"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. The recording is 0.56 seconds long and the editor context has text before, a selection and text after the cursor. Google returns the transcript "um ship the nebula release" in `en-US`.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the WAV file and the editor context.
- Then: The API responds with HTTP 200 and exactly the raw transcript "um ship the nebula release" with language `en-US`, without polishing. The Google request uses 4096 max output tokens, `MINIMAL` thinking, temperature 0, a JSON schema requiring `transcript` and `language`, and a system instruction stating it is a transcription engine that does not contain the editor text. The user message has the base64 WAV audio part first and then a text part containing the editor context JSON, the previous-transcript-tail label and the statement that audio is the only source of new speech.

## voice-io-transcribe-009

- Vitest: "voice input routing and reference context > transcribes a 60-second recording without polishing"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. The recording is 60 seconds long and the editor context has text before, a selection and text after the cursor. Google returns the transcript "um ship the nebula release" in `en-US`.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the WAV file and the editor context.
- Then: The API responds with HTTP 200 and exactly the raw transcript "um ship the nebula release" with language `en-US`, without polishing. The Google request uses 4096 max output tokens, `MINIMAL` thinking, temperature 0, a JSON schema requiring `transcript` and `language`, and a system instruction stating it is a transcription engine that does not contain the editor text. The user message has the base64 WAV audio part first and then a text part containing the editor context JSON, the previous-transcript-tail label and the statement that audio is the only source of new speech.

## voice-io-transcribe-010

- Vitest: "voice input routing and reference context > rejects invalid editor context before contacting the provider: oversized selection"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file and an editor context whose selection is 1,001 characters long.
- Then: The API responds with HTTP 400.

## voice-io-transcribe-011

- Vitest: "POST /api/voice-io/transcribe/segment > transcribes OAuth voice input with the existing paid-tier quota"
- Mode: run
- Given: A member with a Pro entitlement authenticates with an OAuth access token scoped `user:org:read okou:voice:transcribe`. Google returns the transcript "Recorded speech.".
- When: The caller reads `GET /api/voice-io/quota`, sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file, and reads the quota again.
- Then: The segment request returns HTTP 200 with exactly `{ transcript: "Recorded speech.", language: "en" }`. The quota is allowed with a count of 0 before the request and is unchanged afterwards.

## voice-io-transcribe-012

- Vitest: "POST /api/voice-io/transcribe/segment > rejects a previous transcript beyond the bounded prefix"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file, a 1,001-character previous transcript and a total duration of 61 seconds.
- Then: The API responds with HTTP 400.

## voice-io-transcribe-013

- Vitest: "POST /api/voice-io/transcribe/segment > retains bounded failure evidence without private content or duplicate reports"
- Mode: run
- Given: A signed-in organization admin with a Pro entitlement sends private editor context and previous transcript text, a client request ID header and a deployment commit SHA. Retry delays elapse immediately. Google in turn returns an implausibly long transcript, a `MAX_TOKENS` truncation with usage metadata, a truncation with malformed usage metadata, plain non-JSON text, an HTTP 403, a long transcript under a private request ID and commit SHA, persistent HTTP 429 with `Retry-After: 60`, and `[NO_SPEECH]`.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file once per scenario.
- Then: The rate, truncation, invalid-output, HTTP and private-correlation cases return HTTP 502 and each logs exactly one `voice_transcription_failure` record with the stage, reason, Google model and Vertex provider, audio and total duration of 1 second, valid usage counts and character counts only, and the client request ID and commit SHA only when they are not private. The exhausted-capacity case returns HTTP 503 with one terminal log and no failure record, and the no-speech case returns HTTP 204 with no failure log. No log or response contains the private content.

## voice-io-transcribe-014

- Vitest: "POST /api/voice-io/transcribe/segment > accepts the 60-minute recording boundary and rejects longer recordings"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` once with a total recording duration of exactly 60 minutes and once with 60 minutes plus one second.
- Then: The 60-minute request returns HTTP 200 and the longer request returns HTTP 400.

## voice-io-transcribe-015

- Vitest: "POST /api/voice-io/transcribe/segment > returns no content for silent audio without discarding client-owned earlier text"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns the transcript `[NO_SPEECH]` with language `und`.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file, the previous transcript "Earlier speech." and a total duration of 61 seconds.
- Then: The API responds with HTTP 204 and no body.

## voice-io-transcribe-016

- Vitest: "POST /api/voice-io/transcribe/segment > keeps plausible speech and leaves suspicious short audio retryable: {\"transcript\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"duration\":1,\"status\":200}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns a 99-character transcript for a 1-second recording.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the 1-second WAV file and a total duration of 1 second.
- Then: The API responds with HTTP 200.

## voice-io-transcribe-017

- Vitest: "POST /api/voice-io/transcribe/segment > keeps plausible speech and leaves suspicious short audio retryable: {\"transcript\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"duration\":4,\"status\":200}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns a 100-character transcript for a 4-second recording.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the 4-second WAV file and a total duration of 4 seconds.
- Then: The API responds with HTTP 200.

## voice-io-transcribe-018

- Vitest: "POST /api/voice-io/transcribe/segment > keeps plausible speech and leaves suspicious short audio retryable: {\"transcript\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",\"duration\":1,\"status\":502}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns a 100-character transcript for a 1-second recording.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the 1-second WAV file and a total duration of 1 second.
- Then: The API responds with HTTP 502, leaving the segment retryable.

## voice-io-transcribe-019

- Vitest: "POST /api/voice-io/transcribe/segment > keeps plausible speech and leaves suspicious short audio retryable: {\"transcript\":\"Hello, I am calling to inquire about the status of my recent order, number 45678. Could you please provide an update on when I might expect delivery?\",\"duration\":0.1,\"status\":502}"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns a 147-character customer-service sentence for a 0.1-second recording.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the 0.1-second WAV file and a total duration of 0.1 seconds.
- Then: The API responds with HTTP 502, leaving the segment retryable.

## voice-io-transcribe-020

- Vitest: "POST /api/voice-io/transcribe/segment > rejects implausible final output without discarding saved speech"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits and Google returns a 200-character invented transcript for a one-second recording.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with the one-second WAV file, the previous transcript "Earlier speech." and a total duration of 61 seconds.
- Then: The API responds with HTTP 502 and error code `VOICE_TRANSCRIPTION_FAILED`.

## voice-io-transcribe-021

- Vitest: "POST /api/voice-io/transcribe/segment > counts a recording only after independent polish succeeds"
- Mode: run
- Given: A signed-in organization admin was funded with 10,000 credits and then had the subscription cancelled, leaving the `limited-free-1` tier. Retry delays elapse immediately. Google transcribes segments successfully, then returns HTTP 503 with `Retry-After: 60` for polish, then returns the polished text "First part. Second part.".
- When: The admin sends two segments to `POST /api/voice-io/transcribe/segment` (60 seconds, then 3 seconds with 2 seconds of overlap), then calls `POST /api/voice-io/polish/segments` with both segment texts twice, reading `GET /api/voice-io/quota` after each phase.
- Then: Both segments return HTTP 200 and the quota count stays 0. The failed polish returns HTTP 503 and the count stays 0. The successful polish returns HTTP 200 with "First part. Second part." and the quota then shows a count of 1 and still allowed.

## voice-io-transcribe-022

- Vitest: "POST /api/voice-io/transcribe/segment > reports daily request exhaustion through quota and rejects further segments"
- Mode: run
- Given: The clock is 2026-10-02 12:00 UTC. A signed-in organization admin is on the `limited-free-1` tier after a cancelled subscription and Google transcribes every segment successfully.
- When: The admin reads `GET /api/voice-io/quota`, sends 40 one-second segments to `POST /api/voice-io/transcribe/segment`, reads the quota again and sends a 41st segment.
- Then: The initial quota is allowed with count 0. All 40 segments return HTTP 200 and the quota then is exactly `{ allowed: false, count: 40, limit: 40 }`. The 41st segment returns HTTP 429 with error code `DAILY_RATE_LIMIT_EXCEEDED`.

## voice-io-transcribe-023

- Vitest: "POST /api/voice-io/transcribe/segment > meters unique recording time without charging the boundary overlap twice"
- Mode: run
- Given: A signed-in organization admin is on the `limited-free-1` tier after a cancelled subscription and Google transcribes every segment successfully.
- When: The admin sends segments totalling 482 seconds, then a 60-second segment and a 60-second segment with a 2-second overlap to `POST /api/voice-io/transcribe/segment`, reads `GET /api/voice-io/quota`, and sends one more one-second segment.
- Then: All segments return HTTP 200. The quota shows `allowed: false`, count 600 and limit 600, so the overlap is not counted twice. The extra segment returns HTTP 429 with error code `DAILY_DURATION_LIMIT_EXCEEDED`.

## voice-io-transcribe-024

- Vitest: "POST /api/voice-io/transcribe/segment > transcribes every segment with the same prompt and returns only new text"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns "LaunchPad is ready." for the first segment and "Send it tomorrow." for the second.
- When: The admin sends a 60-second segment to `POST /api/voice-io/transcribe/segment`, then a 3-second segment with the first transcript as previous text, a total of 61 seconds and a 2-second overlap.
- Then: The second response is exactly `{ transcript: "Send it tomorrow.", language: "en" }`. Both Google requests use the same system instruction, the second uses 4096 max output tokens, and its user content includes the first transcript.

## voice-io-transcribe-025

- Vitest: "POST /api/voice-io/transcribe/segment > requires audio even when an earlier transcript exists"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with no audio file, the previous transcript "Earlier speech." and a total duration of 60 seconds.
- Then: The API responds with HTTP 400 and the error message "No audio file provided".

## voice-io-transcribe-026

- Vitest: "POST /api/voice-io/transcribe/segment > rejects invalid segment duration 2 / 62 / 2"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a 2-second recording, a total duration of 62 seconds and a 2-second overlap.
- Then: The API responds with HTTP 400.

## voice-io-transcribe-027

- Vitest: "POST /api/voice-io/transcribe/segment > rejects invalid segment duration 36.57 / 36.56 / 0"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a 36.57-second recording, a total duration of 36.56 seconds and no overlap.
- Then: The API responds with HTTP 400.

## voice-io-transcribe-028

- Vitest: "POST /api/voice-io/transcribe/segment > rejects an oversized segment before invoking the provider"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a 76-second recording and a total duration of 76 seconds.
- Then: The API responds with HTTP 400.

## voice-io-transcribe-029

- Vitest: "voice provider immediate failures > returns provider-unavailability for a connection failure at https://sts.us-west1.rep.googleapis.com…"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and the Google STS token exchange fails at the connection level.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. The STS endpoint is called 3 times.

## voice-io-transcribe-030

- Vitest: "voice provider immediate failures > returns provider-unavailability for a connection failure at /^https:\\/\\/iamcredentials\\.googleapis\\.com\\/v1\\/projects\\/-\\/serviceAccounts\\/[^/]+:generateAccessToken$/u"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and the Google service-account impersonation endpoint fails at the connection level.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. The impersonation endpoint is called 3 times.

## voice-io-transcribe-031

- Vitest: "voice provider immediate failures > returns provider-unavailability for a connection failure at /^https:\\/\\/(?:us-west1-aiplatform|aiplatform\\.us\\.rep)\\.googleapis\\.com\\/v1\\/projects\\/[^/]+\\/locations\\/(?:us|us-west1)\\/publishers\\/google\\/models\\/gemini-[^/:]+:generateContent$/u"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and the Vertex generation endpoint fails at the connection level.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. The Vertex generation endpoint is called once.

## voice-io-transcribe-032

- Vitest: "voice provider immediate failures > reports invalid structured Google output as a transcription failure"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns structured output with a transcript but no `language` field.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and error code `VOICE_TRANSCRIPTION_FAILED`.

## voice-io-transcribe-033

- Vitest: "voice provider capacity recovery > recovers HTTP 429 without prematurely counting a recording"
- Mode: run
- Given: A signed-in organization admin is on the `limited-free-1` tier after a cancelled subscription. Retry delays elapse immediately and Google returns HTTP 429 once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file and then reads `GET /api/voice-io/quota`.
- Then: The segment returns HTTP 200 with "Recorded speech.". Google receives two identical requests. The quota shows count 0 and still allowed.

## voice-io-transcribe-034

- Vitest: "voice provider capacity recovery > recovers HTTP 503 without prematurely counting a recording"
- Mode: run
- Given: A signed-in organization admin is on the `limited-free-1` tier after a cancelled subscription. Retry delays elapse immediately and Google returns HTTP 503 once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file and then reads `GET /api/voice-io/quota`.
- Then: The segment returns HTTP 200 with "Recorded speech.". Google receives two identical requests. The quota shows count 0 and still allowed.

## voice-io-transcribe-035

- Vitest: "voice provider capacity recovery > ends persistent capacity failures after three attempts"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and Google returns HTTP 429 for the first three calls and a transcript afterwards.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 503 and exactly the error `PROVIDER_UNAVAILABLE` with the message "Speech recognition is temporarily busy. Please retry in a moment.". Google is called 3 times.

## voice-io-transcribe-036

- Vitest: "voice provider capacity recovery > honors Retry-After 2 during recovery"
- Mode: run
- Given: The clock is 2026-09-09 08:00:00 UTC and advances with each retry wait. A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns HTTP 429 with `Retry-After: 2` once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 200 with "Recorded speech.". Google is called at 08:00:00 and again 2,000 ms later.

## voice-io-transcribe-037

- Vitest: "voice provider capacity recovery > honors Retry-After 60 during recovery"
- Mode: run
- Given: The clock is 2026-09-09 08:00:00 UTC and advances with each retry wait. A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns HTTP 429 with `Retry-After: 60` once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 200 with "Recorded speech.". Google is called at 08:00:00 and again 60,000 ms later.

## voice-io-transcribe-038

- Vitest: "voice provider capacity recovery > honors Retry-After Wed, 09 Sep 2026 08:00:03 GMT during recovery"
- Mode: run
- Given: The clock is 2026-09-09 08:00:00 UTC and advances with each retry wait. A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns HTTP 429 with the HTTP-date `Retry-After: Wed, 09 Sep 2026 08:00:03 GMT` once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 200 with "Recorded speech.". Google is called at 08:00:00 and again 3,000 ms later.

## voice-io-transcribe-039

- Vitest: "voice provider capacity recovery > honors Retry-After invalid during recovery"
- Mode: run
- Given: The clock is 2026-09-09 08:00:00 UTC and advances with each retry wait. A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google returns HTTP 429 with an unparseable `Retry-After: invalid` once, then the transcript "Recorded speech.".
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 200 with "Recorded speech.". Google is called at 08:00:00 and again after the default 1,000 ms.

## voice-io-transcribe-040

- Vitest: "voice provider capacity recovery > keeps provider authentication errors non-retryable"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and Google returns HTTP 401 on the first call and a transcript afterwards.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and error code `VOICE_TRANSCRIPTION_FAILED`. Google is called exactly once.

## voice-io-transcribe-041

- Vitest: "voice provider capacity recovery > keeps an invalid successful response as a genuine transcription failure"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Retry delays elapse immediately and Google returns HTTP 200 with an empty candidates list.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file.
- Then: The API responds with HTTP 502 and error code `VOICE_TRANSCRIPTION_FAILED`. Google is called exactly once.

## voice-io-transcribe-042

- Vitest: "voice provider capacity recovery > cancels backoff with the request owner"
- Mode: run
- Given: A signed-in organization admin has an active Pro subscription funded with 10,000 credits. Google always returns HTTP 429, so the API waits before retrying.
- When: The admin sends `POST /api/voice-io/transcribe/segment` with a one-second WAV file and cancels the request while the API is waiting to retry.
- Then: The request rejects with an `AbortError` "Request cancelled". Google is called only once.
