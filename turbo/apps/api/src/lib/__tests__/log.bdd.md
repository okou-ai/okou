# log

## log-001

- Vitest: "native Worker logging > exports structured fields once without application SDK flushes"
- Mode: run
- Intent: review
- Given: The API runs inside a Cloudflare Worker request runtime with native telemetry export enabled, console output is captured, and the deployed commit SHA is forty `d` characters.
- When: Code logs `warn("Provider unavailable", …)` through the `NativeLogger` logger with provider-unavailable fields (`clerk`, status 503, `transient_read_exhausted`, `GET /api/chat-threads`) and then flushes logs.
- Then: Exactly one structured console warn record is written containing `_time`, level `warn`, the message, `source: api`, the provider fields lifted to the root, a nested `fields` object with the same fields plus `context: NativeLogger`, `axiom_dataset: vm0-web-logs-dev`, `okou_runtime: cloudflare-workers` and the commit SHA. Nothing is written with console log, and the Axiom SDK neither receives a warn nor is flushed.

## log-002

- Vitest: "native Worker logging > keeps the SDK transport when the Worker has no native export destination"
- Mode: run
- Intent: review
- Given: The API runs inside a Worker request runtime without native telemetry export.
- When: Code logs `info("Retained SDK delivery")` through the `UnconfiguredWorker` logger and flushes logs.
- Then: The Axiom SDK receives exactly one info entry with that message and `context: UnconfiguredWorker`, and the SDK is flushed once.

## log-003

- Vitest: "debug environment > keeps the info level for missing canonical input"
- Mode: run
- Intent: review
- Given: The `OKOU_DEBUG` environment variable is not set.
- When: Code creates the `debug-target` logger.
- Then: The logger level is `info`.

## log-004

- Vitest: "debug environment > preserves the global wildcard behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to the global wildcard `*`.
- When: Code creates loggers named `anything` and `api:worker`.
- Then: Both loggers have level `debug`.

## log-005

- Vitest: "debug environment > preserves a namespace-prefix wildcard behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to the namespace-prefix wildcard `api:*`.
- When: Code creates loggers named `api:worker`, `api:`, `api` and `apis:worker`.
- Then: `api:worker` and `api:` have level `debug`; `api` and `apis:worker` stay at `info`.

## log-006

- Vitest: "debug environment > preserves an exact logger name behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to the exact logger name `ExactLogger`.
- When: Code creates loggers named `ExactLogger`, `exactlogger` and `ExactLogger:child`.
- Then: Only `ExactLogger` has level `debug`; the lowercase name and the child name stay at `info`.

## log-007

- Vitest: "debug environment > preserves trimmed comma-separated entries behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to `exact-one, , api:*, exact-two,` (comma-separated entries with surrounding spaces and empty entries).
- When: Code creates loggers named `exact-one`, `api:child`, `exact-two`, `exact` and `other`.
- Then: `exact-one`, `api:child` and `exact-two` have level `debug`; `exact` and `other` stay at `info`.

## log-008

- Vitest: "debug environment > preserves discarded empty entries behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to `,  ,` (only empty entries).
- When: Code creates the `anything` logger.
- Then: The logger stays at level `info`.

## log-009

- Vitest: "debug environment > preserves a non-matching pattern behavior"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to `another-logger`.
- When: Code creates the `target-logger` logger.
- Then: The logger stays at level `info`.

## log-010

- Vitest: "debug environment > does not emit the canonical environment value to logs"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to a long private pattern string (`private-debug-pattern-` followed by 113 `x` characters).
- When: Code creates a logger whose name equals that pattern.
- Then: The logger has level `debug`, and no debug, info, warn or error entry is sent to Axiom.

## log-011

- Vitest: "debug environment > keeps configuration and logger levels cached until the existing reset"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is set to `CachedLogger` and the `CachedLogger` logger has been created.
- When: The variable changes to `AfterResetLogger`, code requests both loggers again, then the logger cache is reset and `AfterResetLogger` is requested again.
- Then: Before the reset the same cached `CachedLogger` instance is returned with level `debug` and `AfterResetLogger` has level `info`; after the reset `AfterResetLogger` has level `debug`.

## log-012

- Vitest: "debug environment > keeps the generic DEBUG convention unrelated"
- Mode: run
- Intent: review
- Given: `OKOU_DEBUG` is not set and the generic `DEBUG` variable is set to `*`.
- When: Code creates the `generic-debug-convention` logger.
- Then: The logger level is `info`.

## log-013

- Vitest: "logToAxiom level dispatch > dispatches debug to alog.debug with source: api"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `debug("hello", { key: "value" })` on the `test-debug` logger.
- Then: Axiom receives a debug entry `hello` with fields `key: value`, `context: test-debug` and event root `source: api`.

## log-014

- Vitest: "logToAxiom level dispatch > dispatches info to alog.info with source: api"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info("info msg")` on the `test-info` logger.
- Then: Axiom receives an info entry `info msg` with `context: test-info` and event root `source: api`.

## log-015

- Vitest: "logToAxiom level dispatch > dispatches warn to alog.warn with source: api"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `warn("warning")` on the `test-warn` logger.
- Then: Axiom receives a warn entry `warning` with `context: test-warn` and event root `source: api`.

## log-016

- Vitest: "logToAxiom level dispatch > dispatches error to alog.error with source: api"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error("boom")` on the `test-err` logger.
- Then: Axiom receives an error entry `boom` with `context: test-err` and event root `source: api`.

## log-017

- Vitest: "logToAxiom level dispatch > dispatches fatal to alog.error with source: api"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `fatal("dead")` on the `test-fatal` logger.
- Then: Axiom receives an error-level entry `dead` with `context: test-fatal` and event root `source: api`.

## log-018

- Vitest: "logToAxiom level dispatch > converts non-string first arg to string for the Axiom message"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info` on the `test-obj` logger with a plain object `{ nested: true }` as the first argument.
- Then: Axiom receives an info entry whose message is the object's string conversion, with event root `source: api`.

## log-019

- Vitest: "logToAxiom level dispatch > uses a fallback Axiom message when string conversion throws"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info` on the `test-bad-string` logger with a value whose string conversion throws.
- Then: The call does not throw, and Axiom receives an info entry with message `[Unreadable]` and event root `source: api`.

## log-020

- Vitest: "Axiom log source field > includes source: api in info logs"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info("msg")` on the `source-test` logger.
- Then: Axiom receives an info entry `msg` whose event root contains `source: api`.

## log-021

- Vitest: "Axiom log source field > includes source: api in error logs with Error objects"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error` on the `source-err` logger with an Error whose message is `fail`.
- Then: Axiom receives an error entry with message `fail` whose event root contains `source: api`.

## log-022

- Vitest: "Axiom log source field > uses a fallback Axiom message when Error.message is unreadable"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error's `message` getter throws.
- When: Code calls `error` on the `source-unreadable-err` logger with that Error.
- Then: The call does not throw, and Axiom receives an error entry with message `[Unreadable]`, a serialized `error` field whose message is `[Unreadable]`, and event root `source: api`.

## log-023

- Vitest: "Axiom log source field > places context before spread fields so user fields don't overwrite context"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `warn("msg", { context: "evil" })` on the `ctx-test` logger.
- Then: Axiom receives a warn entry `msg` whose `context` is `ctx-test` (the logger name, not `evil`) with event root `source: api`.

## log-024

- Vitest: "Axiom log source field > lifts usage underbilling fields into the Axiom event root"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error("underbilling", …)` on the `underbilling-test` logger with type `usage_underbilling`, reason `run_not_found`, `underbilling_class: confirmed`, `component: api` and `orgId: org-test`.
- Then: Axiom receives the error entry with all fields plus `context`, and the event root contains `source: api`, `type`, `reason`, `underbilling_class` and `component` but not `orgId`.

## log-025

- Vitest: "Axiom log source field > lifts unhandled request error fields into the Axiom event root"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error` on the `unhandled-request-test` logger with type `unhandled_request_error`, an error summary, route `/api/test/:id`, method `GET`, error code `42703` and a nested `error` object.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains `source: api`, `type`, `errorSummary`, `route`, `method` and `errorCode` but not the nested `error`.

## log-026

- Vitest: "Axiom log source field > lifts sanitized provider-unavailable fields for 521 / transient_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `521` (number) with failure class `transient_read_exhausted`.
- When: Code calls `error` on the `provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains `source: api` plus `type`, `provider`, `provider_status: 521`, `failure_class`, `method` and `route`.

## log-027

- Vitest: "Axiom log source field > lifts sanitized provider-unavailable fields for null / transport_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `null` with failure class `transport_read_exhausted`.
- When: Code calls `error` on the `provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains `source: api` plus `type`, `provider`, `provider_status: null`, `failure_class`, `method` and `route`.

## log-028

- Vitest: "Axiom log source field > does not lift invalid provider status/class pair 521 / transient_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status string `"521"` with failure class `transient_read_exhausted`.
- When: Code calls `error("provider error", …)` on the `malformed-provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-029

- Vitest: "Axiom log source field > does not lift invalid provider status/class pair null / transient_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `null` with failure class `transient_read_exhausted`.
- When: Code calls `error("provider error", …)` on the `malformed-provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-030

- Vitest: "Axiom log source field > does not lift invalid provider status/class pair 521 / transport_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `521` (number) with failure class `transport_read_exhausted`.
- When: Code calls `error("provider error", …)` on the `malformed-provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-031

- Vitest: "Axiom log source field > does not lift invalid provider status/class pair undefined / transport_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `undefined` with failure class `transport_read_exhausted`.
- When: Code calls `error("provider error", …)` on the `malformed-provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-032

- Vitest: "Axiom log source field > does not lift invalid provider status/class pair 404 / transient_read_exhausted"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured; the parameter row is provider status `404` with failure class `transient_read_exhausted`.
- When: Code calls `error("provider error", …)` on the `malformed-provider-unavailable-test` logger with type `provider_unavailable`, provider `clerk`, that status and class, method `POST` and route `/api/data/router/requests`.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-033

- Vitest: "Axiom log source field > lifts desktop update manifest outcome fields into the Axiom event root"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `warn` on the `desktop-update-manifest-test` logger with type `desktop_update_manifest_upstream`, outcome `unavailable`, provider `cloudflare_r2`, status 503, `transient_read_exhausted`, 3 attempts, line `ai-okou-desktop`, method `GET` and the desktop `RELEASES.json` route.
- Then: Axiom receives the warn entry with all fields plus `context`, and the event root contains `source: api` plus every one of those manifest fields.

## log-034

- Vitest: "Axiom log source field > does not lift a desktop update manifest event with an unknown outcome"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `warn("manifest event", …)` on the `desktop-update-manifest-outcome-test` logger with type `desktop_update_manifest_upstream` and the unknown outcome `degraded` (failure class `transient_read`, 1 attempt).
- Then: Axiom receives the warn entry with all fields plus `context`, and the event root contains only `source: api`.

## log-035

- Vitest: "Axiom log source field > does not lift unknown type fields into the Axiom event root"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error("custom event", …)` on the `unknown-type-test` logger with type `custom_event`, an error summary, route and method.
- Then: Axiom receives the entry with all fields plus `context`, and the event root contains only `source: api`.

## log-036

- Vitest: "flushLogs > calls alog.flush()"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured and the `flush-test` logger has logged one info message.
- When: Code flushes logs.
- Then: The Axiom SDK is flushed exactly once.

## log-037

- Vitest: "flushLogs > does not throw when flush fails"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, a message has been logged, and the Axiom flush rejects with `flush down`.
- When: Code flushes logs.
- Then: The flush resolves to `undefined` without throwing.

## log-038

- Vitest: "flushLogs > does not throw when axiom is not initialized"
- Mode: run
- Intent: review
- Given: The logger state has been reset so no Axiom logger has been created yet.
- When: Code flushes logs.
- Then: The flush resolves to `undefined` without throwing.

## log-039

- Vitest: "flushLogs > reports Axiom transport timeouts as contextual warnings"
- Mode: run
- Intent: review
- Given: Console output is captured, the deployed commit SHA is forty `a` characters, and logs have been flushed once so the Axiom client exists.
- When: The Axiom client reports a `TimeoutError` (`The operation was aborted due to timeout`).
- Then: Reporting does not throw. The console warns `Axiom application log delivery timed out` with client `telemetry`, dataset `vm0-web-logs-dev`, `failureKind: timeout`, the commit SHA and the serialized error (name, message, stack). No console error is written and no warn or error is sent back to Axiom.

## log-040

- Vitest: "flushLogs > reports other Axiom transport failures as contextual errors"
- Mode: run
- Intent: review
- Given: Console output is captured, the deployed commit SHA is forty `b` characters, and logs have been flushed once so the Axiom client exists.
- When: The Axiom client reports a `TypeError` `fetch failed` caused by `connection refused` with code `ECONNREFUSED` and syscall `connect`.
- Then: Reporting does not throw. The console errors `Axiom application log delivery failed` with client `telemetry`, dataset `vm0-web-logs-dev`, `failureKind: transport_error`, the commit SHA and the serialized error including its cause message, code and syscall. No console warning is written and no warn or error is sent back to Axiom.

## log-041

- Vitest: "serializeError via logging > includes non-enumerable Error properties in Axiom fields"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error` on the `serialize` logger with an Error `test error`.
- Then: Axiom receives an error entry `test error` whose `error` field includes the non-enumerable `name: Error`, `message` and a string `stack`, with event root `source: api`.

## log-042

- Vitest: "serializeError via logging > recursively serializes error.cause"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `error` on the `cause-test` logger with an Error `wrapped` whose cause is an Error `root cause`.
- Then: Axiom receives an error entry `wrapped` whose `error.cause` is serialized with `name: Error` and `message: root cause`.

## log-043

- Vitest: "serializeError via logging > serializes cyclic error causes without throwing"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error `wrapped` has itself as its cause.
- When: Code calls `error` on the `cyclic-cause-test` logger with that Error.
- Then: Axiom receives an error entry `wrapped` whose `error.cause` is `[Circular]`.

## log-044

- Vitest: "serializeError via logging > truncates deep error cause chains"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error `depth-0` has a cause chain 80 levels deep (`depth-1` … `depth-80`).
- When: Code calls `error` on the `deep-cause-test` logger with that Error.
- Then: The serialized `error` field contains `depth-32` and `[Truncated]` and does not contain `depth-80`.

## log-045

- Vitest: "serializeError via logging > serializes cyclic enumerable error fields into JSON-safe values"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error `request failed` has an enumerable `request` object with a URL, a BigInt `retryAfter` of 1 and a self-reference.
- When: Code calls `error` on the `cyclic-enumerable-test` logger with that Error.
- Then: The serialized `error` contains the message and a `request` with the URL, `retryAfter: "1"` and `self: [Circular]`, and the serialized error can be JSON-stringified without throwing.

## log-046

- Vitest: "serializeError via logging > serializes unreadable error properties without throwing"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error `request failed` has a `cause` getter and an enumerable `request` getter that both throw.
- When: Code calls `error` on the `unreadable-error-test` logger with that Error.
- Then: The call does not throw, and the serialized `error` has the message with `cause: [Unreadable]` and `request: [Unreadable]`.

## log-047

- Vitest: "serializeError via logging > bounds enumerable object fields before reading later properties"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error has an enumerable `request` object with 80 getter fields where fields 64 and later throw when read.
- When: Code calls `error` on the `large-enumerable-test` logger with that Error.
- Then: The call does not throw; the serialized request keeps `field0` = 0 and `field63` = 63, omits `field64`, has a truthy `__truncated` marker, and the serialized error is JSON-safe.

## log-048

- Vitest: "serializeError via logging > serializes non-string error stacks into JSON-safe values"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error's `stack` getter returns the BigInt 1.
- When: Code calls `error` on the `non-string-stack-test` logger with that Error.
- Then: The call does not throw, the serialized `stack` is the string `1`, and the serialized error is JSON-safe.

## log-049

- Vitest: "serializeError via logging > bounds serialized error string fields"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error has a 10,000-character message and a 10,000-character stack.
- When: Code calls `error("msg", err)` on the `long-error-string-test` logger.
- Then: The serialized error message and stack are each truncated to 4,093 characters followed by `...`.

## log-050

- Vitest: "serializeError via logging > preserves special enumerable keys as data fields"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error has an enumerable own `constructor` field with a string value and an enumerable `payload` whose own `__proto__` key holds `{ nested: true }`.
- When: Code calls `error` on the `special-key-error-test` logger with that Error.
- Then: The serialized error and payload are plain objects with the standard Object prototype, the error has an own `constructor` data field equal to `error-constructor-field`, and the payload has an own `__proto__` data field equal to `{ nested: true }`.

## log-051

- Vitest: "serializeError via logging > bounds the total serialized error graph"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error has a `payload` with 64 child objects of 64 fields each.
- When: Code calls `error` on the `wide-error-graph-test` logger with that Error.
- Then: The JSON-serialized error contains `[Truncated]` and is shorter than 100,000 characters.

## log-052

- Vitest: "serializeError via logging > surfaces custom enumerable properties on Error"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured, and an Error `custom` has custom enumerable `code: ERR_TEST` and `statusCode: 500`.
- When: Code calls `error` on the `custom-err` logger with that Error.
- Then: The serialized `error` field includes `name: Error`, `message: custom`, `code: ERR_TEST` and `statusCode: 500`.

## log-053

- Vitest: "extractFields via logging > wraps Error second argument under { error: ... }"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info("oh no", err)` on the `extract-err` logger with an Error `boom` as the second argument.
- Then: Axiom receives an info entry `oh no` whose fields contain an `error` object with message `boom`.

## log-054

- Vitest: "extractFields via logging > passes plain object second argument directly as fields"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info("data", { count: 42 })` on the `extract-obj` logger.
- Then: Axiom receives an info entry `data` with exactly `count: 42`, `context: extract-obj` and event root `source: api`.

## log-055

- Vitest: "extractFields via logging > wraps multiple extra args in { args: [...] }"
- Mode: run
- Intent: review
- Given: Axiom application logging is configured.
- When: Code calls `info("msg", 1, "two", { three: 3 })` on the `extract-multi` logger.
- Then: Axiom receives an info entry `msg` whose fields contain `args: [1, "two", { three: 3 }]`.

## log-056

- Vitest: "logger > caches logger instances by name"
- Mode: run
- Intent: review
- Given: No special configuration.
- When: Code requests the `Cache` logger twice.
- Then: Both requests return the same logger instance.
