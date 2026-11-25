# instrument-export

## instrument-export-001

- Vitest: "callback export content assertions > ignores numeric fixture collisions in SDK metadata and retains ordinary content"
- Mode: run
- Intent: review
- Given: A trace export and a Sentry error event contain the numbers `123456789` and `1700000000` only inside SDK metadata (trace and span IDs, Unix-nano timestamps, event IDs, error and breadcrumb timestamps), plus ordinary content such as the span name `GET /health`, an event name, an error message and a breadcrumb message.
- When: The test's own content extractor reduces the exports to their content fields (names, attributes, trace state, status messages, error payload fields).
- Then: The raw exports contain both numbers but the extracted content contains neither, while it still contains `GET /health`, `ordinary event`, `ordinary error` and `ordinary breadcrumb`.

## instrument-export-002

- Vitest: "callback export content assertions > retains leaked callback value 123456789 in trace content"
- Mode: run
- Intent: review
- Given: The leaked callback value is `123456789`, placed in turn in a span name, a string or integer span attribute, span trace state, status message, event name, event attribute, link attribute, link trace state, a nested key-value attribute, a resource attribute and an instrumentation-scope attribute.
- When: The test's content extractor processes each single-span or single-resource trace export.
- Then: The extracted content contains `123456789` for every placement, so the extractor does not hide leaked callback values in trace content.

## instrument-export-003

- Vitest: "callback export content assertions > retains leaked callback value 1700000000 in trace content"
- Mode: run
- Intent: review
- Given: The leaked callback value is `1700000000`, placed in turn in a span name, a string or integer span attribute, span trace state, status message, event name, event attribute, link attribute, link trace state, a nested key-value attribute, a resource attribute and an instrumentation-scope attribute.
- When: The test's content extractor processes each single-span or single-resource trace export.
- Then: The extracted content contains `1700000000` for every placement, so the extractor does not hide leaked callback values in trace content.

## instrument-export-004

- Vitest: "callback export content assertions > retains leaked callback value 123456789 in error content"
- Mode: run
- Intent: review
- Given: The leaked callback value is `123456789`, placed in turn in a Sentry error event's message, logentry params, request URL and data, exception value, extra, user ID, tags, custom contexts, trace context data, tags, link attributes and description, and breadcrumb message or data.
- When: The test's content extractor processes each single error event.
- Then: The extracted content contains `123456789` for every placement, so the extractor does not hide leaked callback values in error content.

## instrument-export-005

- Vitest: "callback export content assertions > retains leaked callback value 1700000000 in error content"
- Mode: run
- Intent: review
- Given: The leaked callback value is `1700000000`, placed in turn in a Sentry error event's message, logentry params, request URL and data, exception value, extra, user ID, tags, custom contexts, trace context data, tags, link attributes and description, and breadcrumb message or data.
- When: The test's content extractor processes each single error event.
- Then: The extracted content contains `1700000000` for every placement, so the extractor does not hide leaked callback values in error content.

## instrument-export-006

- Vitest: "API telemetry exports > exports ordinary API telemetry while excluding sensitive provider data"
- Mode: run
- Intent: review
- Given: The API starts with real Sentry and OpenTelemetry instrumentation in production mode, exporting traces to Axiom (`vm0-traces-dev`, bearer `trace-token`, version `dependency-upgrade`) and errors to a Sentry DSN, serving the Telegram integration, health and mail routes. A signed-in member has a chat thread and a connected Gmail account; Gmail rejects a draft lookup with HTTP 400 carrying a private message and reason; the Telegram Bot API answers token-bearing bot requests with 200, 429 or 502; Axiom ingest and APL endpoints accept requests.
- When: The caller sends Telegram login callbacks to `GET /api/integrations/telegram/auth-callback` carrying a secret hash, identity, `id=123456789` and `auth_date=1700000000` with valid and invalid protocol parameters, a Discord OAuth callback, requests made while `APP_URL` is an opaque `mailto:` URL, `GET /health`, a look-alike callback path, and a Gmail draft link request with a private draft ID; the process also calls the Gmail send API, the Telegram Bot API, Axiom ingest and APL, and records SDK breadcrumbs, events and exceptions containing those URLs and secrets.
- Then: The callback requests return 422, 200, 422, 422, 422, 404 and 422; Discord returns 404; the opaque-URL callback and `/sign-in` return 500 with an `Invalid URL` exception; `/health` returns 200, the look-alike path 404 and the draft link 500 with a `Failed to read Gmail draft ... invalid` exception. Exported traces carry `service.name` `vm0-api` and the version, include the `api-regression`, `telegram-calls`, `GET /health`, look-alike path, APL and Gmail send spans but no `/ingest` spans; Sentry envelopes carry `"app":"api"`, the API error and the `/health` metadata. Neither traces nor errors contain the Telegram hash, identity, bot token, Gmail draft ID (raw or encoded), the private Gmail message or reason, or the callback values `123456789` and `1700000000`.
