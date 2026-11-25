# voice-io-polish

## voice-io-polish-001

- Vitest: "POST /api/voice-io/polish > classifies a Google body I/O failure with ECONNRESET"
- Mode: run
- Given: A signed-in organization admin has completed onboarding, Google Vertex voice credentials are configured, and the Google generation response body fails mid-read with the network error code `ECONNRESET`.
- When: The admin sends `POST /api/voice-io/polish/segments` with a session bearer token and the segment "Synthetic dictation.".
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. Google generation is called exactly once.

## voice-io-polish-002

- Vitest: "POST /api/voice-io/polish > classifies a Google body I/O failure with UND_ERR_BODY_TIMEOUT"
- Mode: run
- Given: A signed-in organization admin has completed onboarding, Google Vertex voice credentials are configured, and the Google generation response body fails mid-read with the network error code `UND_ERR_BODY_TIMEOUT`.
- When: The admin sends `POST /api/voice-io/polish/segments` with a session bearer token and the segment "Synthetic dictation.".
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. Google generation is called exactly once.

## voice-io-polish-003

- Vitest: "POST /api/voice-io/polish > classifies a Google body I/O failure with CERT_HAS_EXPIRED"
- Mode: run
- Given: A signed-in organization admin has completed onboarding, Google Vertex voice credentials are configured, and the Google generation response body fails mid-read with the TLS error code `CERT_HAS_EXPIRED`.
- When: The admin sends `POST /api/voice-io/polish/segments` with a session bearer token and the segment "Synthetic dictation.".
- Then: The API responds with HTTP 502 and error code `VOICE_POLISH_FAILED`. Google generation is called exactly once.

## voice-io-polish-004

- Vitest: "POST /api/voice-io/polish > classifies a Google connection failure without replaying generation"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and the Google generation endpoint fails at the network connection level.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "Synthetic dictation.".
- Then: The API responds with HTTP 503 and error code `PROVIDER_UNAVAILABLE`. Google generation is called exactly once, with no replay.

## voice-io-polish-005

- Vitest: "POST /api/voice-io/polish > retains the maximum text contract with JSON escaping and rejects oversize output"
- Mode: run
- Given: A signed-in organization admin has completed onboarding. Google first returns polished text of 262,144 characters made mostly of control characters that need JSON escaping, then returns 262,145 characters, then returns a raw body larger than 2 MiB.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "Synthetic dictation." three times, once per Google response.
- Then: The first request returns HTTP 200 with exactly the 262,144-character text. The second (one character over the limit) and third (oversize raw body) requests return HTTP 502.

## voice-io-polish-006

- Vitest: "POST /api/voice-io/polish > recovers a temporary Google polish failure on the same model"
- Mode: run
- Given: A signed-in organization admin has completed onboarding. Google generation returns HTTP 503 on the first call and polished text on the second.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "Synthetic dictation.".
- Then: The API responds with HTTP 200. Google is called twice on the same URL, which targets the `us` location and the `gemini-3.1-flash-lite:generateContent` model.

## voice-io-polish-007

- Vitest: "POST /api/voice-io/polish > rejects unusable Google output for blocked"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and Google returns a candidate blocked with finish reason `SAFETY`.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "private user dictation".
- Then: The API responds with HTTP 502 and error code `VOICE_POLISH_FAILED`.

## voice-io-polish-008

- Vitest: "POST /api/voice-io/polish > rejects unusable Google output for non_stop"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and Google returns a candidate with an unknown, non-STOP finish reason.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "private user dictation".
- Then: The API responds with HTTP 502 and error code `VOICE_POLISH_FAILED`.

## voice-io-polish-009

- Vitest: "POST /api/voice-io/polish > rejects unusable Google output for empty_output"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and Google returns a STOP candidate whose only part is thought text, so there is no usable output.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "private user dictation".
- Then: The API responds with HTTP 502 and error code `VOICE_POLISH_FAILED`.

## voice-io-polish-010

- Vitest: "POST /api/voice-io/polish > preserves public provider errors and rejects incomplete polish"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and retry delays elapse immediately. Google in turn returns a 400 unsupported-value error, a 429, a 503, a 200 carrying an error object, a 200 with a prompt blocked for safety, a `MAX_TOKENS`-truncated candidate, and a STOP candidate with only whitespace, each with `Retry-After: 20` and private provider detail.
- When: The admin sends `POST /api/voice-io/polish/segments` with the segment "um prepare the update" once per Google response.
- Then: The 429 and 503 cases return HTTP 503 with exactly `PROVIDER_UNAVAILABLE` and the message "Voice draft cleanup is temporarily unavailable". All other cases return HTTP 502 with exactly `VOICE_POLISH_FAILED` and the message "Voice draft cleanup failed to produce a usable response". No provider detail is exposed.

## voice-io-polish-011

- Vitest: "POST /api/voice-io/polish > merges ordered segments with session without answering speech or translating it"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and authenticates with a Clerk session. Google returns the polished text "Ship the release on Monday.".
- When: The admin sends `POST /api/voice-io/polish/segments` with the ordered segments "um ship the nebula release Friday" and "no Monday".
- Then: The API responds with HTTP 200 and exactly `{ text: "Ship the release on Monday." }`. The Google request sends the segments as a JSON user message, uses temperature 0, `MINIMAL` thinking, a max output token count equal to the combined segment length plus 4096, a system instruction containing "Include every segment, not just the last one.", and no response MIME type.

## voice-io-polish-012

- Vitest: "POST /api/voice-io/polish > merges ordered segments with oauth without answering speech or translating it"
- Mode: run
- Given: A signed-in organization admin has completed onboarding and authenticates with an OAuth access token scoped `user:org:read okou:voice:transcribe`. Google returns the polished text "Ship the release on Monday.".
- When: The caller sends `POST /api/voice-io/polish/segments` with the ordered segments "um ship the nebula release Friday" and "no Monday".
- Then: The API responds with HTTP 200 and exactly `{ text: "Ship the release on Monday." }`. The Google request sends the segments as a JSON user message, uses temperature 0, `MINIMAL` thinking, a max output token count equal to the combined segment length plus 4096, a system instruction containing "Include every segment, not just the last one.", and no response MIME type.

## voice-io-polish-013

- Vitest: "POST /api/voice-io/polish > rejects unusable or oversized combined transcripts before generation: oversized total"
- Mode: run
- Given: A signed-in organization admin has completed onboarding.
- When: The admin sends `POST /api/voice-io/polish/segments` with two segments of 131,073 and 131,072 characters, an oversized combined total.
- Then: The API responds with HTTP 400.

## voice-io-polish-014

- Vitest: "POST /api/voice-io/polish > requires authentication"
- Mode: run
- Given: The caller is unauthenticated.
- When: The caller sends `POST /api/voice-io/polish/segments` without an authorization header and the segment "Hello".
- Then: The API responds with HTTP 401.
