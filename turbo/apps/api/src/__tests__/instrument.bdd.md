# instrument

## instrument-001

- Vitest: "instrument > registers OpenTelemetry with api metadata and an OTLP Axiom exporter"
- Mode: run
- Intent: review
- Given: The API is configured with git commit `abc123`.
- When: API observability initializes.
- Then: OpenTelemetry receives the service name `vm0-api`, service version `abc123`, and an OTLP HTTP trace exporter for Axiom.

## instrument-002

- Vitest: "instrument > does not initialize Sentry without a DSN"
- Mode: run
- Intent: review
- Given: The API has no Sentry DSN.
- When: API observability initializes.
- Then: The Sentry SDK is not initialized.

## instrument-003

- Vitest: "instrument > does not initialize Sentry outside production"
- Mode: run
- Intent: review
- Given: The API runs in preview with a configured Sentry DSN.
- When: API observability initializes.
- Then: The Sentry SDK is not initialized.

## instrument-004

- Vitest: "instrument > initializes Sentry with api metadata"
- Mode: run
- Intent: review
- Given: The production API has a Sentry DSN and git commit `abc123`.
- When: API observability initializes and its incoming HTTP request-body collection policy is evaluated.
- Then: The Sentry SDK receives the DSN, production environment, release `abc123`, app tag `api`, a 500 ms shutdown timeout, and event and breadcrumb filters. SDK logs, default PII, sampling, SDK OpenTelemetry setup, HTTP spans and trace propagation are disabled. The HTTP integration excludes bodies for the tested Telegram and Discord authentication callbacks and allows the health request through that exclusion check.
