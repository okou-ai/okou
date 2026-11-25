# voice-google-auth-retry

## voice-google-auth-retry-001

- Vitest: "Google token recovery through the public voice API > recovers sts HTTP 429 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 429: the Google STS token exchange first answers HTTP 429 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The Google STS token exchange is called twice and Vertex inference exactly once.

## voice-google-auth-retry-002

- Vitest: "Google token recovery through the public voice API > recovers sts HTTP 500 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 500: the Google STS token exchange first answers HTTP 500 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The Google STS token exchange is called twice and Vertex inference exactly once.

## voice-google-auth-retry-003

- Vitest: "Google token recovery through the public voice API > recovers sts HTTP 502 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 502: the Google STS token exchange first answers HTTP 502 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The Google STS token exchange is called twice and Vertex inference exactly once.

## voice-google-auth-retry-004

- Vitest: "Google token recovery through the public voice API > recovers sts HTTP 503 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 503: the Google STS token exchange first answers HTTP 503 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The Google STS token exchange is called twice and Vertex inference exactly once.

## voice-google-auth-retry-005

- Vitest: "Google token recovery through the public voice API > recovers sts HTTP 504 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 504: the Google STS token exchange first answers HTTP 504 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The Google STS token exchange is called twice and Vertex inference exactly once.

## voice-google-auth-retry-006

- Vitest: "Google token recovery through the public voice API > recovers impersonation HTTP 429 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 429: the service-account impersonation (`generateAccessToken`) first answers HTTP 429 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The service-account impersonation (`generateAccessToken`) is called twice and Vertex inference exactly once.

## voice-google-auth-retry-007

- Vitest: "Google token recovery through the public voice API > recovers impersonation HTTP 500 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 500: the service-account impersonation (`generateAccessToken`) first answers HTTP 500 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The service-account impersonation (`generateAccessToken`) is called twice and Vertex inference exactly once.

## voice-google-auth-retry-008

- Vitest: "Google token recovery through the public voice API > recovers impersonation HTTP 502 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 502: the service-account impersonation (`generateAccessToken`) first answers HTTP 502 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The service-account impersonation (`generateAccessToken`) is called twice and Vertex inference exactly once.

## voice-google-auth-retry-009

- Vitest: "Google token recovery through the public voice API > recovers impersonation HTTP 503 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 503: the service-account impersonation (`generateAccessToken`) first answers HTTP 503 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The service-account impersonation (`generateAccessToken`) is called twice and Vertex inference exactly once.

## voice-google-auth-retry-010

- Vitest: "Google token recovery through the public voice API > recovers impersonation HTTP 504 before inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 504: the service-account impersonation (`generateAccessToken`) first answers HTTP 504 with a private error body, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`. The service-account impersonation (`generateAccessToken`) is called twice and Vertex inference exactly once.

## voice-google-auth-retry-011

- Vitest: "Google token recovery through the public voice API > recovers sts transport failure (body=false)"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / body=false: the Google STS token exchange first fails at the network level, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`, and the Google STS token exchange is called twice.

## voice-google-auth-retry-012

- Vitest: "Google token recovery through the public voice API > recovers sts transport failure (body=true)"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / body=true: the Google STS token exchange first returns a response whose body stream errors with a body timeout, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`, and the Google STS token exchange is called twice.

## voice-google-auth-retry-013

- Vitest: "Google token recovery through the public voice API > recovers impersonation transport failure (body=false)"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / body=false: the service-account impersonation (`generateAccessToken`) first fails at the network level, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`, and the service-account impersonation (`generateAccessToken`) is called twice.

## voice-google-auth-retry-014

- Vitest: "Google token recovery through the public voice API > recovers impersonation transport failure (body=true)"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / body=true: the service-account impersonation (`generateAccessToken`) first returns a response whose body stream errors with a body timeout, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 with exactly `{ text: "Recovered dictation." }`, and the service-account impersonation (`generateAccessToken`) is called twice.

## voice-google-auth-retry-015

- Vitest: "Google token recovery through the public voice API > retains the successful STS exchange while recovering impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." The STS exchange succeeds; impersonation answers HTTP 503 twice and then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200. The STS exchange is called once, impersonation three times, each with `Bearer synthetic-sts-token` and the body `{ scope: [cloud-platform], lifetime: "3600s" }`, and Vertex inference once.

## voice-google-auth-retry-016

- Vitest: "Google token recovery through the public voice API > bounds sts attempts and allows a later request to recover"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts`: the Google STS token exchange answers HTTP 503 with a private error body three times, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` twice.
- Then: The first request returns HTTP 503 with error code `PROVIDER_UNAVAILABLE`, does not include the private detail, makes exactly three sts attempts and no inference. The second request returns HTTP 200 after one more attempt (four in total) and one inference.

## voice-google-auth-retry-017

- Vitest: "Google token recovery through the public voice API > bounds impersonation attempts and allows a later request to recover"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation`: the service-account impersonation (`generateAccessToken`) answers HTTP 503 with a private error body three times, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` twice.
- Then: The first request returns HTTP 503 with error code `PROVIDER_UNAVAILABLE`, does not include the private detail, makes exactly three impersonation attempts and no inference. The second request returns HTTP 200 after one more attempt (four in total) and one inference.

## voice-google-auth-retry-018

- Vitest: "Google token recovery through the public voice API > does not retry sts HTTP 400"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 400: the Google STS token exchange always answers HTTP 400 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-019

- Vitest: "Google token recovery through the public voice API > does not retry sts HTTP 401"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 401: the Google STS token exchange always answers HTTP 401 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-020

- Vitest: "Google token recovery through the public voice API > does not retry sts HTTP 403"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 403: the Google STS token exchange always answers HTTP 403 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-021

- Vitest: "Google token recovery through the public voice API > does not retry sts HTTP 404"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 404: the Google STS token exchange always answers HTTP 404 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-022

- Vitest: "Google token recovery through the public voice API > does not retry sts HTTP 501"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts` / 501: the Google STS token exchange always answers HTTP 501 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 without the private detail, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-023

- Vitest: "Google token recovery through the public voice API > does not retry impersonation HTTP 400"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 400: the service-account impersonation (`generateAccessToken`) always answers HTTP 400 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-024

- Vitest: "Google token recovery through the public voice API > does not retry impersonation HTTP 401"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 401: the service-account impersonation (`generateAccessToken`) always answers HTTP 401 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-025

- Vitest: "Google token recovery through the public voice API > does not retry impersonation HTTP 403"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 403: the service-account impersonation (`generateAccessToken`) always answers HTTP 403 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-026

- Vitest: "Google token recovery through the public voice API > does not retry impersonation HTTP 404"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 404: the service-account impersonation (`generateAccessToken`) always answers HTTP 404 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 without the private detail, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-027

- Vitest: "Google token recovery through the public voice API > does not retry impersonation HTTP 501"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation` / 501: the service-account impersonation (`generateAccessToken`) always answers HTTP 501 with a private error body.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 without the private detail, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-028

- Vitest: "Google token recovery through the public voice API > does not retry malformed successful sts output"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `sts`: the Google STS token exchange answers HTTP 200 with the non-JSON body `not-json`.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and the Google STS token exchange is called exactly once.

## voice-google-auth-retry-029

- Vitest: "Google token recovery through the public voice API > does not retry malformed successful impersonation output"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." Parameter row `impersonation`: the service-account impersonation (`generateAccessToken`) answers HTTP 200 with the non-JSON body `not-json`.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and the service-account impersonation (`generateAccessToken`) is called exactly once.

## voice-google-auth-retry-030

- Vitest: "Google token recovery through the public voice API > backs off successive token requests with independent jitter"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." The clock starts at 2026-10-10T00:00:00Z and advances by each retry wait. Impersonation answers HTTP 503 twice, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 after three impersonation requests. The first wait is at least 1000 ms and under 2000 ms, and the second wait is at least 2000 ms and under 3000 ms.

## voice-google-auth-retry-031

- Vitest: "Google token recovery through the public voice API > honors a Retry-After seconds minimum before retrying"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." The clock starts at 2026-10-10T00:00:00Z and advances by each retry wait. Parameter row `seconds`: impersonation first answers HTTP 429 with `Retry-After: 4`, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 after two impersonation requests made exactly 4000 ms apart.

## voice-google-auth-retry-032

- Vitest: "Google token recovery through the public voice API > honors a Retry-After http-date minimum before retrying"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (Google STS token exchange, then service-account impersonation), with no OpenRouter fallback configured, and Vertex returns the text "Recovered dictation." The clock starts at 2026-10-10T00:00:00Z and advances by each retry wait. Parameter row `http-date`: impersonation first answers HTTP 429 with a `Retry-After` HTTP date four seconds in the future, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 200 after two impersonation requests made exactly 4000 ms apart.
