# voice-google-auth

## voice-google-auth-001

- Vitest: "Google voice workload identity through the public API > reports temporary sts I/O failure (body=false) after bounded token retries"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `sts` / body=false: the Google STS token exchange always fails at the network level.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `PROVIDER_UNAVAILABLE`, after exactly three Google STS token exchange attempts.

## voice-google-auth-002

- Vitest: "Google voice workload identity through the public API > reports temporary impersonation I/O failure (body=false) after bounded token retries"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `impersonation` / body=false: the service-account impersonation (`generateAccessToken`) always fails at the network level.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `PROVIDER_UNAVAILABLE`, after exactly three service-account impersonation (`generateAccessToken`) attempts.

## voice-google-auth-003

- Vitest: "Google voice workload identity through the public API > reports temporary sts I/O failure (body=true) after bounded token retries"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `sts` / body=true: the Google STS token exchange always returns a response whose body stream errors with a body timeout.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `PROVIDER_UNAVAILABLE`, after exactly three Google STS token exchange attempts.

## voice-google-auth-004

- Vitest: "Google voice workload identity through the public API > reports temporary impersonation I/O failure (body=true) after bounded token retries"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `impersonation` / body=true: the service-account impersonation (`generateAccessToken`) always returns a response whose body stream errors with a body timeout.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `PROVIDER_UNAVAILABLE`, after exactly three service-account impersonation (`generateAccessToken`) attempts.

## voice-google-auth-005

- Vitest: "Google voice workload identity through the public API > preserves denied auth even when its body fails at https://sts.us-west1.rep.googleapis.com/v1/token"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `sts`: the Google STS token exchange answers HTTP 403 and its body stream then fails with a connection reset.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`.

## voice-google-auth-006

- Vitest: "Google voice workload identity through the public API > preserves denied auth even when its body fails at /^https:\\/\\/iamcredentials\\.googleapis\\.com\\/v1\\/projects\\/-\\/serviceAccounts\\/[^/]+:generateAccessToken$/u"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `impersonation`: the service-account impersonation (`generateAccessToken`) answers HTTP 403 and its body stream then fails with a connection reset.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`.

## voice-google-auth-007

- Vitest: "Google voice workload identity through the public API > exchanges the current Vercel identity in Oregon, impersonates the exact account, and reuses short-lived credentials"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. The STS exchange, impersonation and Vertex all succeed.
- When: The admin calls `POST /api/voice-io/polish/segments` twice.
- Then: Both requests return HTTP 200. The STS exchange is called once without an `authorization` header and with the token-exchange form (grant type token-exchange, audience `//iam.googleapis.com/<workload identity provider>`, scope `cloud-platform`, requested access token, JWT subject `synthetic-vercel-runtime-token`). Impersonation is called once for the configured service account with `Bearer synthetic-sts-token` and body `{ scope: [cloud-platform], lifetime: "3600s" }`. Vertex is called twice with `Bearer impersonated-token`.

## voice-google-auth-008

- Vitest: "Google voice workload identity through the public API > accepts Google's clock skew without extending credential reuse"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. The clock is 2026-09-11T08:00:00Z, and impersonation returns a token expiring 61 minutes later (one minute beyond the requested hour).
- When: The admin polishes at 08:00:00, again at 08:54:59, and again at 08:55:00.
- Then: The first request returns HTTP 200 with `{ text: "Synthetic dictation." }`, and Vertex receives `Bearer clock-skew-token`. The 08:54:59 request reuses the token (one impersonation in total); the 08:55:00 request triggers a second impersonation.

## voice-google-auth-009

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_PROJECT_ID before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_PROJECT_ID` is not configured.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-010

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_WORKLOAD_IDENTITY_PROVIDER before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` is not configured.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-011

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_SERVICE_ACCOUNT_EMAIL before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_SERVICE_ACCOUNT_EMAIL` is not configured.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-012

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_PROJECT_ID before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_PROJECT_ID` is set to the invalid value `../other`.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-013

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_WORKLOAD_IDENTITY_PROVIDER before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` is set to the invalid value `https://attacker.example/token`.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-014

- Vitest: "Google voice workload identity through the public API > rejects missing or invalid GCP_LLM_SERVICE_ACCOUNT_EMAIL before external work"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row: `GCP_LLM_SERVICE_ACCOUNT_EMAIL` is set to the invalid value `llm-dev@example.com/path`.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 503 with error code `NOT_CONFIGURED`, and no request is made to any `googleapis.com` endpoint.

## voice-google-auth-015

- Vitest: "Google voice workload identity through the public API > rejects a missing runtime identity without using user OAuth or OpenRouter"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. No Vercel runtime identity token is available.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 and the Google STS endpoint is never called.

## voice-google-auth-016

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"access_token\":\"\"} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"access_token":""}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-017

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"token_type\":\"MAC\"} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"token_type":"MAC"}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-018

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"issued_token_type\":\"urn:ietf:params:oauth:token-type:jwt\"} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"issued_token_type":"urn:ietf:params:oauth:token-type:jwt"}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-019

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"expires_in\":-1} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expires_in":-1}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-020

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"expires_in\":\"3600\"} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expires_in":"3600"}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-021

- Vitest: "Google voice workload identity through the public API > rejects malformed STS credentials {\"expires_in\":7200} without impersonation"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expires_in":7200}`: the STS exchange answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`, and impersonation is never called.

## voice-google-auth-022

- Vitest: "Google voice workload identity through the public API > rejects unusable service-account credentials {\"accessToken\":\"\"} without inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"accessToken":""}`: impersonation answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502, and Vertex inference is never called.

## voice-google-auth-023

- Vitest: "Google voice workload identity through the public API > rejects unusable service-account credentials {\"expireTime\":\"not-a-date\"} without inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expireTime":"not-a-date"}`: impersonation answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502, and Vertex inference is never called.

## voice-google-auth-024

- Vitest: "Google voice workload identity through the public API > rejects unusable service-account credentials {\"expireTime\":\"2020-01-01T00:00:00Z\"} without inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expireTime":"2020-01-01T00:00:00Z"}`: impersonation answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502, and Vertex inference is never called.

## voice-google-auth-025

- Vitest: "Google voice workload identity through the public API > rejects unusable service-account credentials {\"expireTime\":\"2999-01-01T00:00:00Z\"} without inference"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `{"expireTime":"2999-01-01T00:00:00Z"}`: impersonation answers HTTP 200 with an otherwise valid token response overridden by this field.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502, and Vertex inference is never called.

## voice-google-auth-026

- Vitest: "Google voice workload identity through the public API > bounds credential response bodies at https://sts.us-west1.rep.googleapis.com/v1/token"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `sts`: the Google STS token exchange answers with a body of 64 KiB plus one byte.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`.

## voice-google-auth-027

- Vitest: "Google voice workload identity through the public API > bounds credential response bodies at /^https:\\/\\/iamcredentials\\.googleapis\\.com\\/v1\\/projects\\/-\\/serviceAccounts\\/[^/]+:generateAccessToken$/u"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `impersonation`: the service-account impersonation (`generateAccessToken`) answers with a body of 64 KiB plus one byte.
- When: The admin calls `POST /api/voice-io/polish/segments` with one segment "Synthetic dictation."
- Then: The response is HTTP 502 with error code `VOICE_POLISH_FAILED`.

## voice-google-auth-028

- Vitest: "Google voice workload identity through the public API > does not retry denied auth HTTP 401 and permits a later request to recover"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `401`: impersonation first answers HTTP 401 with a private error message, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` twice.
- Then: The first request returns HTTP 502 without the private detail after exactly one impersonation attempt. The second request returns HTTP 200 after one more attempt (two in total).

## voice-google-auth-029

- Vitest: "Google voice workload identity through the public API > does not retry denied auth HTTP 403 and permits a later request to recover"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Parameter row `403`: impersonation first answers HTTP 403 with a private error message, then succeeds.
- When: The admin calls `POST /api/voice-io/polish/segments` twice.
- Then: The first request returns HTTP 502 without the private detail after exactly one impersonation attempt. The second request returns HTTP 200 after one more attempt (two in total).

## voice-google-auth-030

- Vitest: "Google voice workload identity through the public API > reuses credentials until the five-minute expiry margin"
- Mode: run
- Given: A signed-in workspace admin has completed onboarding. Voice polishing uses Google Vertex AI through workload-identity federation (the Vercel runtime identity is exchanged at the Oregon Google STS endpoint, then a service account is impersonated), with no OpenRouter fallback configured. Impersonation returns tokens that expire one hour after issue.
- When: The admin polishes at a start time, again 3,200 seconds later, and again 3,301 seconds after the start.
- Then: All three requests return HTTP 200. The second request reuses the first token (one impersonation), and the third request triggers a second impersonation.
