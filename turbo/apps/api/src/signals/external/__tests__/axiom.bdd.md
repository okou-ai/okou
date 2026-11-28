# axiom

## axiom-001

- Vitest: "shared SDK ingestion > preserves independent filesystem samples through the metrics HTTP transport"
- Mode: run
- Intent: review
- Given: A signed-in member has started a chat Run and its sandbox holds the Run's sandbox token. The Axiom metrics dataset `sandbox-telemetry-metrics` accepts ingestion.
- When: The sandbox posts `POST /api/webhooks/run/telemetry` with six metric samples at the same timestamp: rootfs and home stats, rootfs only, home only, neither, rootfs plus a home sample with negative `used_bytes`, and a rootfs sample with negative `used_bytes` plus home.
- Then: The webhook returns HTTP 200 with `{ success: true, id: runId }`. Axiom receives exactly six events with `_time`, run ID, user ID, CPU and memory, carrying flattened `rootfs_*` and `home_*` byte and inode fields only for the valid filesystems present; each invalid negative sample is dropped while the other filesystem in the same sample is kept.

## axiom-002

- Vitest: "shared SDK ingestion > emits ID-free billing timings through the existing operation dataset"
- Mode: run
- Intent: review
- Given: Two billing operation timings are recorded inside the API: an `api_billing_settlement_work` timing of 39 ms with inline settlement dimensions, and an `api_billing_settlement_compaction_lock_wait` timing of 0 ms.
- When: The API records the billing operation timings.
- Then: One ingestion to `vm0-sandbox-op-log-dev` carries two events with `source` `api`, `operation_domain` `billing`, the operation type, duration and success, and exactly the given numeric dimensions, with no user, workspace or run identifiers.

## axiom-003

- Vitest: "shared SDK ingestion > does not throw when billing timing ingestion fails synchronously"
- Mode: run
- Intent: review
- Given: Axiom ingestion throws "telemetry unavailable" synchronously.
- When: The API records one `api_billing_settlement_work` timing of 8 ms.
- Then: Recording does not throw.

## axiom-004

- Vitest: "shared SDK ingestion > preserves archive diagnostics through the sandbox-operation SDK transport"
- Mode: run
- Intent: review
- Given: A signed-in member has started a chat Run and its sandbox holds the Run's sandbox token.
- When: The sandbox posts `POST /api/webhooks/run/telemetry` with three failed `storage_cache_fresh_delivery_headers` operations: a plain one, one with an archive size-mismatch diagnostic that also contains a private archive URL and raw header, and one with an archive connection-attempt diagnostic that also contains a private origin and raw error.
- Then: The webhook returns HTTP 200 with `{ success: true, id: runId }`. `vm0-sandbox-op-log-dev` receives the base event (`source` `sandbox`, `sandbox_type` `runner`, op type, duration, `success: false`, error, run ID), the base plus `archive_size_mismatch_*` expected bytes, response bytes, source kind, source index and content encoding, and the base plus `archive_connection_attempt_*` started, succeeded, failed, dropped, active-at-headers, terminal duration and saturated fields, without the private URL, header, origin or raw error.

## axiom-005

- Vitest: "shared SDK ingestion > preserves staging counts, phase availability and redaction through the webhook"
- Mode: run
- Intent: review
- Given: A signed-in member has started a chat Run and its sandbox holds the Run's sandbox token.
- When: The sandbox posts `POST /api/webhooks/run/telemetry` with three `storage_cache_stage_batch_write` operations whose stage-write data is complete (and also contains a private path, content and archive URL), partial (operation failed), or unavailable.
- Then: The webhook returns HTTP 200 with `{ success: true, id: runId }`. `vm0-sandbox-op-log-dev` receives one event per operation with the base sandbox fields plus `storage_stage_*` file count, content bytes and host timing; the complete event carries all fifteen timing fields, the partial one only `admission_us` and `success: false`, and the unavailable one no timings; private fields are not ingested.

## axiom-006

- Vitest: "shared SDK ingestion > preserves storage batch measurements through the sandbox-operation SDK transport"
- Mode: run
- Intent: review
- Given: A signed-in member has started a chat Run and its sandbox holds the Run's sandbox token.
- When: The sandbox posts `POST /api/webhooks/run/telemetry` with three `runner_storage_manifest_batch_apply` operations: a complete batch with outcome, reason, guest and host timings, resource counters (including a maximum-safe-integer memory peak) plus nested private resource data and a manifest JSON, a partial failed batch, and an unavailable batch.
- Then: The webhook returns HTTP 200 with `{ success: true, id: runId }`. `vm0-sandbox-op-log-dev` receives the complete batch with exactly its flat outcome, reason and `storage_batch_*` measurement fields and payload size bucket, and receives the partial and unavailable batches with their own dimensions; the nested resources, storage control timing and manifest JSON are not ingested.

## axiom-007

- Vitest: "shared SDK ingestion > attributes dataset failures and flushes every selected client"
- Mode: run
- Intent: review
- Given: Telemetry and sessions Axiom tokens are configured, and events are ingested to a request-log dataset (twice), a run-context dataset and an agent-run-events dataset.
- When: The request-log client reports a timeout error and the run-context client a connection error; then Axiom is flushed for the telemetry client, the sessions client, all clients, and again for telemetry while the request-log flush rejects.
- Then: Three Axiom clients are used: request-log and run-context with the telemetry token, agent-run-events with the sessions token, and the request-log client receives both payloads in order. Two "Axiom client operation failed" logs name client `telemetry`, the dataset, failure kind `timeout` or `transport_error`, the API commit SHA and the error, without any token or payload. Telemetry flush waits for both telemetry clients only; sessions flush flushes only the sessions client; a full flush flushes all three; a rejected flush still resolves and logs "Axiom client flush failed" with the dataset and error.

## axiom-008

- Vitest: "Run phase observation transport > writes the authenticated stage timeline with callback provenance (skipResearch=false)"
- Mode: run
- Given: The Run owner in the three-point timing audience enables the artifact three-point timing feature switch and starts a thread Run; web-log telemetry ingestion is live. This row does not skip research (`skipResearch=false`).
- When: Using the Run's Okou token, the Run posts `POST /api/runs/current/phase-mark` with `research-start`, then `generation-start` with kind `report` and `skipResearch: false`, one second apart; the sandbox then completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: Both marks return HTTP 202. Exactly three `run_phase_mark` events (schema version 2, source `callback`, run, user and workspace IDs) reach `vm0-web-logs-dev`: `research-start`, `generation-start` with `generation_kind` `report` and `research_skipped: false`, and `completion-callback`, each timestamped at its receipt time.

## axiom-009

- Vitest: "Run phase observation transport > writes the authenticated stage timeline with callback provenance (skipResearch=true)"
- Mode: run
- Given: The Run owner in the three-point timing audience enables the artifact three-point timing feature switch and starts a thread Run; web-log telemetry ingestion is live. This row skips research (`skipResearch=true`).
- When: Using the Run's Okou token, the Run posts only `POST /api/runs/current/phase-mark` with `generation-start`, kind `report` and `skipResearch: true`; one second later the sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The mark returns HTTP 202. Exactly two `run_phase_mark` events (schema version 2, source `callback`, run, user and workspace IDs) reach `vm0-web-logs-dev`: `generation-start` with `generation_kind` `report` and `research_skipped: true`, and `completion-callback`, each timestamped at its receipt time.

## axiom-010

- Vitest: "Run phase start and completion transport > preserves duplicate raw starts with signed Run identity and server receipt time"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run with an Okou token; web-log telemetry ingestion is live and the clock is fixed.
- When: The Run posts `POST /api/runs/current/phase-mark` four times: `research-start` twice and `generation-start` (kind `report`, `skipResearch: false`) twice.
- Then: Each mark returns HTTP 202, and exactly four events reach `vm0-web-logs-dev` in order, preserving duplicates, each with the server receipt time, schema version 2, type `run_phase_mark`, source `callback`, the signed run, user and workspace IDs, the phase, and for generation starts `generation_kind` `report` and `research_skipped: false`.

## axiom-011

- Vitest: "Run phase start and completion transport > keeps the start receipt accepted when the telemetry provider is unavailable"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run with an Okou token. Axiom web-log ingestion responds with HTTP 503.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start`.
- Then: The mark returns HTTP 202 with `{ schemaVersion: 2, status: "accepted" }` and `cache-control: no-store`. Ingestion is attempted exactly once, and the Run still reads as `running`.

## axiom-012

- Vitest: "Run phase start and completion transport > bounds a stalled start observation without changing its acceptance receipt"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run with an Okou token. Axiom web-log ingestion never answers.
- When: The Run posts `POST /api/runs/current/phase-mark` with `generation-start` and kind `report`.
- Then: The mark returns HTTP 202 with `{ schemaVersion: 2, status: "accepted" }`. The single ingestion attempt is aborted by the transport deadline, and the Run still reads as `running`.

## axiom-013

- Vitest: "Run phase start and completion transport > emits one callback observation without start marks and ignores completion replay"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run and has sent no phase marks; web-log telemetry ingestion is live.
- When: The sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`, then replays `POST /api/webhooks/run/complete` with exit code 0 and a native Claude Code completion.
- Then: Exactly one `run_phase_mark` event with phase `completion-callback` and the run, user and workspace IDs is ingested. The replay returns HTTP 200 with `success: true` and status `completed`, no further event is ingested, and the Run reads as `completed`.

## axiom-014

- Vitest: "Run phase start and completion transport > suppresses collection while preserving normal completion for owner opt-out"
- Mode: run
- Given: The owner in the timing audience has turned the artifact three-point timing feature switch off (owner opt-out) and has a running thread Run; web-log telemetry ingestion is live.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start` and with `generation-start`, then the sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The Run's appended system prompt does not mention `okou run mark`. Both marks return HTTP 404 with `cache-control: no-store`, the Run reads as `completed`, and no telemetry event is ingested.

## axiom-015

- Vitest: "Run phase start and completion transport > suppresses collection while preserving normal completion for non-audience default"
- Mode: run
- Given: A member outside the timing audience with the default feature switch state (non-audience default) has a running thread Run; web-log telemetry ingestion is live.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start` and with `generation-start`, then the sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The Run's appended system prompt does not mention `okou run mark`. Both marks return HTTP 404 with `cache-control: no-store`, the Run reads as `completed`, and no telemetry event is ingested.

## axiom-016

- Vitest: "Run phase start and completion transport > suppresses collection while preserving normal completion for non-audience stored opt-in"
- Mode: run
- Given: A member outside the timing audience has stored the artifact three-point timing feature switch as on (non-audience stored opt-in) and has a running thread Run; web-log telemetry ingestion is live.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start` and with `generation-start`, then the sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The Run's appended system prompt does not mention `okou run mark`. Both marks return HTTP 404 with `cache-control: no-store`, the Run reads as `completed`, and no telemetry event is ingested.

## axiom-017

- Vitest: "Run phase start and completion transport > stops collecting starts and completion points after a live opt-out"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run with an Okou token; web-log telemetry ingestion is live.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start`, the owner then turns the artifact three-point timing feature switch off, the Run posts `generation-start`, and the sandbox completes the Run.
- Then: The first mark returns HTTP 202 and the second HTTP 404 with `cache-control: no-store`. The Run reads as `completed`, and the only ingested event is the `research-start` mark with the run, user and workspace IDs; no completion point is recorded.

## axiom-018

- Vitest: "Run phase start and completion transport > collects callback-provenance observations after live enable for an existing Run"
- Mode: run
- Given: The Run owner in the three-point timing audience starts a thread Run with the artifact three-point timing feature switch off; web-log telemetry ingestion is live.
- When: The Run posts `POST /api/runs/current/phase-mark` with `research-start`, the owner turns the switch on, the Run posts `research-start` and `generation-start` (kind `report`) again, and the sandbox completes the Run.
- Then: The first mark returns HTTP 404 with no event ingested; after enabling both marks return HTTP 202. The Run reads as `completed`, and exactly three callback-source events are ingested: `research-start`, `generation-start` with `generation_kind` `report` and `research_skipped: false`, and `completion-callback`.

## axiom-019

- Vitest: "Run phase start and completion transport > preserves a reported execution failure without inventing a completion point"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run; web-log telemetry ingestion is live.
- When: The sandbox posts `POST /api/webhooks/run/complete` with exit code 1 and error "Generation interrupted".
- Then: The callback returns HTTP 200 with `success: true` and status `failed`, the Run reads as `failed`, and no telemetry event is ingested.

## axiom-020

- Vitest: "Run phase start and completion transport > waits for valid native completion output before recording the callback point"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run; web-log telemetry ingestion is live.
- When: The sandbox first posts `POST /api/webhooks/run/complete` with exit code 0 and a `codex` native completion that does not match the Run, then completes the Run normally with Claude events and completion.
- Then: The invalid completion returns HTTP 400, the Run stays `running`, and no event is ingested. After the valid completion the Run reads as `completed` and exactly one event is ingested.

## axiom-021

- Vitest: "Run phase start and completion transport > preserves cancelled output recovery without recording a normal completion point"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run; web-log telemetry ingestion is live.
- When: The owner cancels the Run (HTTP 200), then the sandbox delivers late output and completion through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The Run reads as `cancelled`, and no telemetry event is ingested.

## axiom-022

- Vitest: "Run phase start and completion transport > bounds a stalled completion observation without changing normal completion"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run. Axiom web-log ingestion never answers.
- When: The sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The single ingestion attempt is aborted by the transport deadline, and the Run reads as `completed`.

## axiom-023

- Vitest: "Run phase start and completion transport > keeps normal completion successful when the telemetry provider is unavailable"
- Mode: run
- Given: The Run owner in the three-point timing audience has a running thread Run. Axiom web-log ingestion responds with HTTP 503.
- When: The sandbox completes the Run through `POST /api/webhooks/run/events` and `POST /api/webhooks/run/complete`.
- Then: The Run reads as `completed`, and ingestion is attempted exactly once.

## axiom-024

- Vitest: "queryAxiom > keeps the Axiom match timestamp when event data contains _time"
- Mode: run
- Intent: review
- Given: The Axiom query service returns one match with match timestamp `2026-06-10T11:00:00Z` whose event data contains `_time: "not-a-timestamp"` and a host.
- When: The API queries the `vm0-sandbox-telemetry-network-dev` dataset.
- Then: The result is exactly one row with `_time` `2026-06-10T11:00:00Z` and the host, keeping the match timestamp over the data field.

## axiom-025

- Vitest: "queryAxiom > sends pagination cursor reads without using the Axiom cache"
- Mode: run
- Intent: review
- Given: The Axiom APL endpoint returns one match with timestamp `2026-06-10T12:00:00Z` whose data contains a bogus `_time` and log "next page".
- When: The API queries an APL statement with pagination cursor `cursor-next-page` and no-cache enabled.
- Then: Exactly one request is sent to `https://api.axiom.co/v1/datasets/_apl?format=legacy&nocache=true` with the sessions bearer token and body containing the APL and cursor; the result is one row with the match timestamp and log "next page".
