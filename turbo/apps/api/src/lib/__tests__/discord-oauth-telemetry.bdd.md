# discord-oauth-telemetry

## discord-oauth-telemetry-001

- Vitest: "filters real Sentry SDK start request/breadcrumb secrets before transport without dropping unrelated events"
- Mode: run
- Intent: review
- Given: Error telemetry contains an OAuth `start` request with a code and state. The request and breadcrumbs include an approval redirect containing state and proof, and request data contains approval proof and completion token values. A separate event and breadcrumb reference `/health`.
- When: The configured Sentry integration emits and flushes the events and breadcrumbs.
- Then: The transport receives exactly one event, retaining the unrelated diagnostic and health URL. No envelope contains the code, state, proof, OAuth request URL or approval redirect.

## discord-oauth-telemetry-002

- Vitest: "filters real Sentry SDK callback request/breadcrumb secrets before transport without dropping unrelated events"
- Mode: run
- Intent: review
- Given: Error telemetry contains an OAuth `callback` request with a code and state. The request and breadcrumbs include an approval redirect containing state and proof, and request data contains approval proof and completion token values. A separate event and breadcrumb reference `/health`.
- When: The configured Sentry integration emits and flushes the events and breadcrumbs.
- Then: The transport receives exactly one event, retaining the unrelated diagnostic and health URL. No envelope contains the code, state, proof, OAuth request URL or approval redirect.

## discord-oauth-telemetry-003

- Vitest: "filters real Sentry SDK approve request/breadcrumb secrets before transport without dropping unrelated events"
- Mode: run
- Intent: review
- Given: Error telemetry contains an OAuth `approve` request with a code and state. The request and breadcrumbs include an approval redirect containing state and proof, and request data contains approval proof and completion token values. A separate event and breadcrumb reference `/health`.
- When: The configured Sentry integration emits and flushes the events and breadcrumbs.
- Then: The transport receives exactly one event, retaining the unrelated diagnostic and health URL. No envelope contains the code, state, proof, OAuth request URL or approval redirect.

## discord-oauth-telemetry-004

- Vitest: "filters real Sentry SDK complete request/breadcrumb secrets before transport without dropping unrelated events"
- Mode: run
- Intent: review
- Given: Error telemetry contains an OAuth `complete` request with a code and state. The request and breadcrumbs include an approval redirect containing state and proof, and request data contains approval proof and completion token values. A separate event and breadcrumb reference `/health`.
- When: The configured Sentry integration emits and flushes the events and breadcrumbs.
- Then: The transport receives exactly one event, retaining the unrelated diagnostic and health URL. No envelope contains the code, state, proof, OAuth request URL or approval redirect.
