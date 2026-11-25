# run-reads.bdd

## run-reads.bdd-001

- Vitest: "RUN-03/RUN-04: run read surface auth matrix > rejects unauthenticated and org-less requests across the run read surfaces"
- Mode: run
- Given: An unauthenticated caller and a signed-in user without an organization target a random run ID.
- When: The unauthenticated caller requests `GET /api/runs/:id`, `GET /api/runs/queue`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/telemetry/events`, `GET /api/runs/:id/network`, `GET /api/logs` and `GET /api/logs/:id`; the org-less user requests the queue, cancel, logs list, telemetry events and network routes.
- Then: Every request returns HTTP 401 with exactly `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## run-reads.bdd-002

- Vitest: "RUN-03/RUN-04: direct run list, detail, and queue reads > keeps limited-free plan concurrency visible when the runtime cap is disabled"
- Mode: run
- Given: A signed-in member has completed limited-free onboarding and the runtime concurrent-run cap is disabled (`CONCURRENT_RUN_LIMIT_CAP=0`).
- When: The member reads `GET /api/runs/queue`.
- Then: The response concurrency shows tier `limited-free-1`, limit 2, active 0, available 2 and an empty `memberUsage` list.

## run-reads.bdd-003

- Vitest: "RUN-03/RUN-04: direct run list, detail, and queue reads > groups active concurrency by workspace member"
- Mode: run
- Given: A Pro workspace owner and an onboarded workspace member each have a subscription model, and each has started one chat thread run through `POST /api/chat/events`.
- When: The owner reads `GET /api/runs/queue`.
- Then: Concurrency shows tier `pro`, limit 3, active 2 and available 1. `memberUsage` has exactly two entries, one for the owner and one for the member, each with display name "BDD User" and 1 active run.

## run-reads.bdd-004

- Vitest: "RUN-03/RUN-04: direct run list, detail, and queue reads > reads the signed event automation trigger source from logs"
- Mode: run
- Given: A Team workspace owner has a chat model and has started an event-triggered (signed webhook) automation run, which is then cancelled.
- When: The owner lists `GET /api/logs`, reads `GET /api/logs/:id` for the run, and lists `GET /api/logs?triggerSource=automation-event`.
- Then: The list's `filters.sources` includes `automation-event`; the detail returns the run ID with `triggerSource: "automation-event"`; the filtered list contains the run.

## run-reads.bdd-005

- Vitest: "RUN-03/RUN-04: direct run list, detail, and queue reads > lists and reads runs through public logs with status and since filters"
- Mode: run
- Given: The runtime concurrency cap is 2. A Pro workspace owner starts thread runs "target run a" and "other run b"; an onboarded member of the same workspace also has a model. Run B is later completed through `POST /api/webhooks/run/complete`.
- When: The owner and member list `GET /api/logs` with no filter, `status=running`, `status=completed&limit=1` and `status=completed&since=<one hour ago>`; read `GET /api/runs/:id` for run B, an unknown ID and the member's run; read `GET /api/runs/queue`; then send another chat prompt, cancel runs, and report the cancelled runs finished.
- Then: Default logs contain both owner prompts and the member's list omits run A. `running` contains run A but not B; `completed` with limit 1 returns only run B with a `startedAt`; the since window contains run B. Run B detail returns `completed` with `startedAt`/`completedAt`; unknown and member-owned runs return 404 "Agent run not found" to the owner while the member reads their own run. The queue shows tier `pro`, limit 2, active 2, available 0 with the owner's task carrying their email and `isOwner: true` and the member's task as `runId: null`, `userEmail: "unknown"`. The new prompt stays queued, still queued after cancellation while active stays 2, then launches once runners report completion (active 1), and active drops to 0 after it is cancelled and finished.

## run-reads.bdd-006

- Vitest: "RUN-03: cancel through the run cancel route > cancels a running run idempotently"
- Mode: run
- Given: A Pro workspace owner has a running thread run whose execution the Runner has received.
- When: The owner sends `POST /api/runs/:id/cancel` using the upper-cased run ID, reads the run, and cancels again.
- Then: The first cancel returns HTTP 200 with exactly `{ id, status: "cancelled", message: "Run cancelled successfully" }`; `GET /api/runs/:id` shows `cancelled`; the repeated cancel returns HTTP 200 with status `cancelled`.

## run-reads.bdd-007

- Vitest: "RUN-03: cancel through the run cancel route > rejects cancellation after a run completes"
- Mode: run
- Given: A Pro workspace owner has a thread run that the sandbox has completed through `POST /api/webhooks/run/complete`.
- When: The owner sends `POST /api/runs/:id/cancel`.
- Then: The response is HTTP 400 with error code `RUN_NOT_CANCELLABLE`.

## run-reads.bdd-008

- Vitest: "RUN-03: cancel through the run cancel route > hides an unknown run from cancellation"
- Mode: run
- Given: A signed-in Pro workspace owner.
- When: The owner sends `POST /api/runs/:id/cancel` for a random unknown run ID.
- Then: The response is HTTP 404 with error code `NOT_FOUND`.

## run-reads.bdd-009

- Vitest: "RUN-03: cancel through the run cancel route > hides another organization's run from cancellation"
- Mode: run
- Given: A Pro workspace owner has a completed thread run; a user from another organization is signed in.
- When: The outsider sends `POST /api/runs/:id/cancel` with the upper-cased run ID.
- Then: The response is HTTP 404 with error code `NOT_FOUND`.

## run-reads.bdd-010

- Vitest: "RUN-01/RUN-02: session continuation, memory policies, and volume pinning > restores volumes, memory, and conversation state when continuing sessions"
- Mode: run
- Given: A funded workspace owner has a subscription model, a read-only Connector skill, a configured Runner group and storage that returns stored session history. A first thread run is dispatched with an empty Memory mount.
- When: The sandbox prepares and commits a Memory version via the storage webhooks, re-prepares the same files with `force: true`, prepares and commits an empty file set, completes the run via `POST /api/webhooks/run/complete` with Claude Code session identity and the Memory output, and the owner continues the same thread through `POST /api/chat/events`.
- Then: The first execution mounts the Connector skill with its SHA-256 and archive size and an empty Memory mount at the canonical Claude memory path with `missingRootPolicy: "preserveParentVersion"`, no archive URL and no manifest presign. The forced re-prepare returns `{ versionId, existing: true }` without new presigns or storage requests; the empty prepare returns the original Memory version. The continued execution has the same vars, the same Connector skill bundle, a native continuation with session ID `bdd-cli-<first run>` and generation run ID of the first run, and a Memory mount with `preserveParentVersion`.

## run-reads.bdd-011

- Vitest: "RUN-01: run admission boundaries > treats the one-run limit as soft for concurrent chat picks and enforces it afterwards"
- Mode: run
- Given: A Pro workspace owner has a chat model and the concurrent-run cap is 1.
- When: The owner sends two chat prompts concurrently through `POST /api/chat/events`, lets background picks finish, lists `GET /api/logs?status=running&limit=50`, then sends a third prompt.
- Then: At least one of the two prompts launches a run and neither is rejected; the running logs list exactly the launched runs. The third prompt stays queued.

## run-reads.bdd-012

- Vitest: "RUN-01: run admission boundaries > enforces chat pick concurrency until the cap is disabled"
- Mode: run
- Given: A Pro workspace owner with a Stripe customer has started three thread runs, filling the Pro limit of 3.
- When: The owner sends a fourth chat prompt through `POST /api/chat/events`, then the concurrent-run cap is disabled and the entitlement is refreshed via a Stripe billing webhook.
- Then: The fourth prompt stays queued while the limit is reached and launches a run after the cap is disabled.

## run-reads.bdd-013

- Vitest: "RUN-01: run admission boundaries > restricts production network-body capture to staff organizations"
- Mode: run
- Given: The API runs in production (preview Vercel env). A Pro workspace owner whose email is on the legacy `vm0.ai` domain is not in a staff organization; a separate Pro user belongs to a staff organization.
- When: Each sends a chat prompt through `POST /api/chat/events` requesting `captureNetworkBodies: true`.
- Then: The non-staff send is rejected by the background pick as `forbidden` before any run exists. The staff organization's prompt launches a run whose Runner execution has `captureNetworkBodies` enabled.

## run-reads.bdd-014

- Vitest: "RUN-04: agent run telemetry families > serves paged Activity events without leaking another member's run"
- Mode: run
- Given: A Pro workspace owner has a completed thread run whose last event sequence is 1, and the telemetry store holds two assistant events (sequence 0 "First event" and 1 "Second event"). A member of the same workspace is signed in.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=1&order=asc`, then follows `nextCursor`; the member reads the first page.
- Then: The first page returns exactly the sequence 0 event with `hasMore: true`, `nextCursor: "sequence:asc:0"`, status `completed` and `lastEventSequence: 1`. The second page returns only sequence 1 with `hasMore` false. The member receives HTTP 404 "Agent run not found". Exactly two event queries reach the telemetry store, filtered by run ID and ordered `sequenceNumber asc`, the second bounded by `sequenceNumber > 0`, both with `noCache` and tabular format.

## run-reads.bdd-015

- Vitest: "RUN-04: agent run telemetry families > pages unique Activity events in asc order after ambiguous trace retries"
- Mode: run
- Given: Row `asc`: a Pro workspace owner has a thread run whose telemetry store holds duplicate retried copies of sequence 0 and 1 events with later timestamps.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=1&order=asc` and follows the cursor.
- Then: The first page returns one event, sequence 0 with the earliest timestamp, `hasMore: true` and `nextCursor: "sequence:asc:0"`. The second page returns only sequence 1 at the earliest timestamp, `hasMore` false and no `nextCursor`.

## run-reads.bdd-016

- Vitest: "RUN-04: agent run telemetry families > pages unique Activity events in desc order after ambiguous trace retries"
- Mode: run
- Given: Row `desc`: a Pro workspace owner has a thread run whose telemetry store holds duplicate retried copies of sequence 0 and 1 events with later timestamps.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=1&order=desc` and follows the cursor.
- Then: The first page returns one event, sequence 1 with the earliest timestamp, `hasMore: true` and `nextCursor: "sequence:desc:1"`. The second page returns only sequence 0 at the earliest timestamp, `hasMore` false and no `nextCursor`.

## run-reads.bdd-017

- Vitest: "RUN-04: agent run telemetry families > does not re-emit an already seen Activity event through sinceTime after a trace retry"
- Mode: run
- Given: A Pro workspace owner has a thread run; the telemetry store holds sequence 0 at T+1s, a retried copy of sequence 0 at T+3s and sequence 1 at T+4s.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=10&order=asc&sinceTime=<T+2s>`.
- Then: The response contains exactly the sequence 1 "New event" created at T+4s, with `hasMore` false; the already-seen sequence 0 is not re-emitted.

## run-reads.bdd-018

- Vitest: "RUN-04: agent run telemetry families > reads tabular Activity aggregation with partial=false"
- Mode: run
- Given: Row `partial=false`: a Pro workspace owner has a thread run and Axiom answers the tabular APL query (aggregated by `arg_min` per sequence) with a complete result containing one event.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=1&order=asc`.
- Then: Axiom receives a tabular, no-cache query with the per-sequence aggregation. The response returns exactly the sequence 0 "Trace" assistant event created at 2026-06-10T10:30:00Z with `hasMore` false.

## run-reads.bdd-019

- Vitest: "RUN-04: agent run telemetry families > reads tabular Activity aggregation with partial=true"
- Mode: run
- Given: Row `partial=true`: a Pro workspace owner has a thread run and Axiom answers the tabular APL query with `isPartial: true`.
- When: The owner reads `GET /api/runs/:id/telemetry/events?limit=1&order=asc`.
- Then: Axiom receives a tabular, no-cache aggregated query, and the request fails with HTTP 500.

## run-reads.bdd-020

- Vitest: "RUN-04: agent run telemetry families > hardens network log rows in the agent read API"
- Mode: run
- Given: A Pro workspace owner has a thread run whose network telemetry holds a non-object row, a row with a non-string time, a row with malformed field types, a blocked HTTP row with model-catalog, OpenRouter and upstream-binding fields, and a DNS row.
- When: The owner reads `GET /api/runs/:id/network?limit=4&order=asc`.
- Then: The response contains exactly two network logs: the malformed row reduced to timestamp, type, the valid `firewall_params.owner`, `request_headers.host` and `response_body_encoding: "binary"`; and the blocked row with all its valid fields, nested `openrouter` generation/model/provider/attempts (dropping `pipeline`) and every upstream-binding field. It has `hasMore: true` and a `time:asc` cursor at 12:01:00Z with tie-breaker `cursor-0003`. The telemetry query uses `noCache: true`.

## run-reads.bdd-021

- Vitest: "RUN-04: agent run telemetry families > keeps same-timestamp network rows reachable across time cursor pages"
- Mode: run
- Given: A Pro workspace owner has a thread run whose network telemetry holds two HTTP rows sharing the same timestamp (time cursors `network-a`, `network-b`) and a later row; a second scenario holds two same-timestamp rows (`desc-a`, `desc-b`) and an older row.
- When: The owner pages `GET /api/runs/:id/network?limit=1` with `order=asc` and then `order=desc`, following each `nextCursor` once.
- Then: Ascending: page 1 returns only first.example.com with `hasMore: true` and a `time:asc` cursor at the shared timestamp with tie-breaker `network-a`; page 2 returns only second.example.com with a `network-b` cursor. Descending: page 1 returns desc-first.example.com (`desc-a` cursor) and page 2 desc-second.example.com (`desc-b` cursor). Each second-page telemetry query resumes from the previous Axiom cursor with `noCache: true`, orders by `_time` in the requested direction, and adds no `_time` or `_timeCursor` range filters.

## run-reads.bdd-022

- Vitest: "RUN-04: agent run telemetry families > fails visibly when a network page cannot advance its cursor"
- Mode: run
- Given: A Pro workspace owner has a thread run whose network telemetry holds a row at the boundary time and a later row, without Axiom time cursors.
- When: The owner requests `GET /api/runs/:id/network?cursor=time:asc:<boundary>:cursor-0000&limit=1&order=asc`.
- Then: The response is HTTP 500 with body `{ error: "Internal server error" }`.

## run-reads.bdd-023

- Vitest: "RUN-04: agent run telemetry families > reads fresh run context within the creation-time window after a cached miss"
- Mode: run
- Given: A Pro workspace owner has a dispatched thread run. The telemetry store's cached reads keep returning the initial empty result, and the run-context snapshot becomes visible only to uncached reads after the first request.
- When: The owner reads `GET /api/runs/:id/context` before and after the snapshot is ingested.
- Then: The first read returns HTTP 404 `{ error: { message: "Run context not available", code: "NOT_FOUND" } }`. The second returns HTTP 200 with the run ID, prompt, session ID and the source, output and Memory storage mounts. Both Axiom requests are uncached and query the run-context dataset for the run ID (latest row, limit 1) in a window from one hour before creation to one hour after the later of creation and start.

## run-reads.bdd-024

- Vitest: "RUN-04: agent run telemetry families > maps agent run context, network, and runner metadata from axiom snapshots"
- Mode: run
- Given: A Pro workspace owner has a completed thread run with run-context and network snapshots in the telemetry store (secrets, vars, environment entries, firewalls in builtin/inline/fallback/historical shapes, volumes, artifact, feature-flag and network-policy entries with invalid items), plus a second dispatched run without snapshots. A workspace member is signed in.
- When: The owner reads `GET /api/runs/:id/context`, `GET /api/runs/:id/network` (all rows, then `limit=2&since=<10:59>`, then a `sequence:asc:1` cursor) and `GET /api/runs/:id/runner` for both runs; the member reads network and runner for the first run.
- Then: Context returns prompt, system prompt, secret names, vars, only valid environment entries (`NODE_ENV`), only the valid `github` network policy, `manualMorningBrief` flag, volume and artifact storage mounts, and sanitized firewalls (inline auth entries mapped to `headers`/`query`, conflicting fallback auth dropped). The bare run's context is 404 "Run context not available". Network returns 4 sanitized logs (junk fields removed, the MAYBE tcp row reduced) with `hasMore` false; the paged read returns 2 logs, `hasMore: true` and a `time:asc` cursor at 11:00:01Z/`cursor-0001`, with the since time in the query; the sequence cursor is HTTP 400; the bare run returns `{ networkLogs: [], hasMore: false }`. Runner reads return a null startup path and version, the `runner-<id>.okou.app` hostname, runner ID and heartbeat generation for both runs. The member gets 404 "Agent run not found" on network and runner reads.

## run-reads.bdd-025

- Vitest: "RUN-04/OPS-01: agent run logs > lists organization run logs with their filter metadata"
- Mode: run
- Given: A Team workspace owner has two cancelled web thread runs and a cancelled signed event automation run; a workspace member has their own cancelled run.
- When: The owner lists `GET /api/logs`.
- Then: The list contains exactly the owner's three runs (not the member's). The first web run shows framework `claude-code`, trigger source `web`, status `cancelled` and its prompt; the automation run shows `automation-event`. `filters.statuses` includes `cancelled` and `filters.sources` is exactly `automation-event` and `web`.

## run-reads.bdd-026

- Vitest: "RUN-04/OPS-01: agent run logs > pages run logs and falls back from malformed cursors"
- Mode: run
- Given: A Team workspace owner has three cancelled runs (two web, one event automation) and a member has a hidden run.
- When: The owner lists `GET /api/logs?limit=1`, follows `pagination.nextCursor`, then lists with `cursor=garbage&limit=1`.
- Then: Page one has one entry, `hasMore: true` and `totalPages: 3`; page two has one different entry and `totalPages: 3`. The malformed cursor falls back to the first page and returns the same first entry.

## run-reads.bdd-027

- Vitest: "RUN-04/OPS-01: agent run logs > filters run logs by status and source"
- Mode: run
- Given: A Team workspace owner has two cancelled web runs and a cancelled event automation run.
- When: The owner lists `GET /api/logs?status=cancelled&triggerSource=web`, the same with `limit=1`, and `GET /api/logs?triggerSource=telegram`.
- Then: The status+source filter returns exactly the two web runs; with limit 1 it returns one entry and `totalPages: 2`; the telegram filter returns an empty data list.

## run-reads.bdd-028

- Vitest: "RUN-04/OPS-01: agent run logs > returns pending and failed run-log detail residue"
- Mode: run
- Given: A signed-in chat user with personal instructions sends a chat prompt while storage download signing is held, so the admitted run stays pending; later a second chat run is dispatched.
- When: While held, the user reads `GET /api/logs/:id` and `GET /api/logs?status=pending`; after release the pending run is cancelled and completed with exit code 1, and the second run is completed via `POST /api/webhooks/run/complete` with exit code 1 and error "bdd failure"; the user reads its log detail.
- Then: The pending run's detail shows status `pending`, `sessionId: null` and `completedAt: null`, and the pending list contains it. The failed run's detail shows status `failed` with `failureReason: "unknown"`.

## run-reads.bdd-029

- Vitest: "RUN-04/OPS-01: agent run logs > reads run-log detail when an older Axiom snapshot has null Storage mounts"
- Mode: run
- Given: A Pro workspace owner has a running thread run whose stored run-context snapshot has `storageMounts: null`, empty volumes and a null artifact.
- When: The owner reads `GET /api/logs/:id`.
- Then: The response is HTTP 200 with the run ID, framework `claude-code`, status `running` and the run's prompt.

## run-reads.bdd-030

- Vitest: "RUN-04/OPS-01: agent run logs > reads run-log list and detail with a dispatched Run token"
- Mode: run
- Given: A Team workspace owner has cancelled web and automation runs and a new dispatched thread run that exposes an `OKOU_TOKEN` in its platform environment.
- When: `GET /api/logs` and `GET /api/logs/:id` (for the first web run) are requested with `Authorization: Bearer <OKOU_TOKEN>`.
- Then: Both return HTTP 200: the list contains the web run and the detail returns its ID.

## run-reads.bdd-031

- Vitest: "RUN-04/OPS-01: agent run logs > filters run logs from an exact time boundary"
- Mode: run
- Given: A Team workspace owner has the standard cancelled runs, plus one run created at time T and another created at T+1 ms, both cancelled.
- When: The owner lists `GET /api/logs?since=<T+1>&limit=100`.
- Then: The list contains the run created at T+1 and omits the run created at T.
