# runners-direct-dispatch

## runners-direct-dispatch-001

- Vitest: "delivers complete input after binding its process"
- Mode: run
- Given: A signed-in Pro member's workspace has a configured Runner group with one officially authenticated direct Runner that accepts dispatches and, while handling the dispatch, reads the Run's assigned Runner.
- When: The member sends a new prompt with `POST /api/chat/events` and the Run is dispatched to the Runner's control endpoint; the member then reads `GET /api/runs/:id/runner`.
- Then: During dispatch, `GET /api/runs/:id/runner` already returns HTTP 200 with the dispatching Runner ID and heartbeat generation. The delivered execution input carries the Run ID, a prompt containing the sent text, a sandbox token, an `OKOU_TOKEN` starting with `vm0_sandbox_`, and content bundles. The Run is `running` and the runner read after launch returns the registered Runner identity.

## runners-direct-dispatch-002

- Vitest: "bootstraps a WebSocket only for the Run owner and uses the assigned Runner"
- Mode: run
- Given: A signed-in Pro member has a running Run assigned to an official direct Runner on host `wss-fixture.okou.app`. Another member of the same organization exists. The Runner's control endpoint issues a 43-character WebSocket ticket that expires in 30 seconds.
- When: The other member and then the Run owner call `POST /api/runs/:id/wss/bootstrap` with a Clerk session.
- Then: The other member receives HTTP 404. The owner receives HTTP 200 with exactly the Runner's ticket and expiry plus `wssUrl` `wss://wss-fixture.okou.app/runners/<runnerId>/sandbox/runs/<runId>`, and `cache-control: no-store`. The ticket request to the Runner carries the official Runner bearer secret and the Runner's heartbeat generation header.

## runners-direct-dispatch-003

- Vitest: "sends a complete 0–160 KiB dispatch with content encoding null"
- Mode: run
- Given: A signed-in Pro member's workspace has one official direct Runner that accepts dispatches. The prompt repeats "Café review." 6,500 times (row `minKiB` 0, `maxKiB` 160, encoding null).
- When: The member sends the prompt with `POST /api/chat/events`, launching a Run that is dispatched to the Runner.
- Then: The Run is `running`. The Runner receives exactly one dispatch with no `content-encoding` and a decoded body of at least 0 and under 160 KiB. The delivered execution input carries the Run ID and the full prompt.

## runners-direct-dispatch-004

- Vitest: "sends a complete 160–256 KiB dispatch with content encoding gzip"
- Mode: run
- Given: A signed-in Pro member's workspace has one official direct Runner that accepts dispatches. The prompt repeats "Café review." 12,000 times (row `minKiB` 160, `maxKiB` 256, encoding gzip).
- When: The member sends the prompt with `POST /api/chat/events`, launching a Run that is dispatched to the Runner.
- Then: The Run is `running`. The Runner receives exactly one dispatch with `content-encoding: gzip` whose decompressed body is at least 160 and under 256 KiB. The delivered execution input carries the Run ID and the full prompt.

## runners-direct-dispatch-005

- Vitest: "sends a complete 256–4096 KiB dispatch with content encoding gzip"
- Mode: run
- Given: A signed-in Pro member's workspace has one official direct Runner that accepts dispatches. The prompt repeats "Café review." 40,000 times (row `minKiB` 256, `maxKiB` 4096, encoding gzip).
- When: The member sends the prompt with `POST /api/chat/events`, launching a Run that is dispatched to the Runner.
- Then: The Run is `running`. The Runner receives exactly one dispatch with `content-encoding: gzip` whose decompressed body is at least 256 and under 4096 KiB. The delivered execution input carries the Run ID and the full prompt.

## runners-direct-dispatch-006

- Vitest: "fails a Run with no serving process and releases its concurrency slot"
- Mode: run
- Given: A signed-in Pro member's workspace has a configured Runner group but no Runner process has registered as serving.
- When: The member sends a prompt with `POST /api/chat/events`, then reads `GET /api/runs/:id/context` and `GET /api/runs/queue`.
- Then: The Run is `failed` with `failureReason` `unknown`. The Run context read returns HTTP 404 and the queue reports zero active concurrency.

## runners-direct-dispatch-007

- Vitest: "persists preparation failure and releases admission before another Run"
- Mode: run
- Given: A signed-in Pro member has personal instructions, a registered official direct Runner, and object-storage URL signing fails with "Object signing is unavailable".
- When: The member sends a prompt with `POST /api/chat/events`, reads the Thread events, the admitted Run and `GET /api/runs/queue`, then, after signing recovers, sends another prompt to the same Thread.
- Then: The send returns HTTP 201 and background preparation fails with "Run execution preparation failed". The admitted Run reads back as `failed` with `failureReason` `unknown`, active concurrency is 0, and the follow-up Run in the same Thread is `running`.

## runners-direct-dispatch-008

- Vitest: "keeps PAT-advertised serving capacity outside the official fleet"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official direct Runner with capacity 1. The member's CLI token is used to heartbeat a different Runner ID on its own host advertising capacity 100 and an active ingress service, and that host would accept any dispatch.
- When: The CLI-token heartbeat posts to `POST /api/runners/heartbeat`, then the member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The CLI-token heartbeat returns HTTP 200, but the Run is `running` on the official Runner: the runner read returns the official Runner's ID and heartbeat generation.

## runners-direct-dispatch-009

- Vitest: "recovers interrupted delivery through the ordinary Run heartbeat timeout"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official direct Runner whose first dispatch hangs and then fails at the network level; later dispatches are accepted. The clock is frozen.
- When: The member sends a prompt with `POST /api/chat/events`, aborts the HTTP request after the Runner receives the dispatch, the clock advances 121 seconds, and the cron calls `GET /api/cron/cleanup-sandboxes` with the cron secret; the member then sends another prompt to the same Thread.
- Then: Before cleanup, the admitted Run's runner read returns the official Runner identity. The cron returns HTTP 200, after which the Run is `timeout` with `failureReason` `unknown` and active concurrency is 0. The follow-up Run in the same Thread is `running` and completes through the public sandbox callbacks.

## runners-direct-dispatch-010

- Vitest: "retries identical bytes on the same process after a lost response and a later 429"
- Mode: run
- Given: A signed-in Pro member's Runner group has a preferred official Runner whose first dispatch is lost at the network level (row `lost`), whose second answers HTTP 429 `busy`, and whose third accepts; a second Runner with capacity 1 would accept any dispatch.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. The first Runner receives exactly three dispatches with byte-identical bodies, the alternative Runner receives none, and the runner read returns the first Runner's ID and heartbeat generation.

## runners-direct-dispatch-011

- Vitest: "retries identical bytes on the same process after a process response and a later 429"
- Mode: run
- Given: A signed-in Pro member's Runner group has a preferred official Runner whose first dispatch answers `accepted` with a different Runner ID (row `process`), whose second answers HTTP 429 `busy`, and whose third accepts; a second Runner with capacity 1 would accept any dispatch.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. The first Runner receives exactly three dispatches with byte-identical bodies, the alternative Runner receives none, and the runner read returns the first Runner's ID and heartbeat generation.

## runners-direct-dispatch-012

- Vitest: "retries identical bytes on the same process after a generation response and a later 429"
- Mode: run
- Given: A signed-in Pro member's Runner group has a preferred official Runner whose first dispatch answers `accepted` with the next heartbeat generation (row `generation`), whose second answers HTTP 429 `busy`, and whose third accepts; a second Runner with capacity 1 would accept any dispatch.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. The first Runner receives exactly three dispatches with byte-identical bodies, the alternative Runner receives none, and the runner read returns the first Runner's ID and heartbeat generation.

## runners-direct-dispatch-013

- Vitest: "retries identical bytes on the same process after a run response and a later 429"
- Mode: run
- Given: A signed-in Pro member's Runner group has a preferred official Runner whose first dispatch answers `accepted` for a different Run ID (row `run`), whose second answers HTTP 429 `busy`, and whose third accepts; a second Runner with capacity 1 would accept any dispatch.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. The first Runner receives exactly three dispatches with byte-identical bodies, the alternative Runner receives none, and the runner read returns the first Runner's ID and heartbeat generation.

## runners-direct-dispatch-014

- Vitest: "stops retrying an ambiguous first dispatch once the Run is cancelled"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official Runner that, on its first dispatch, has the member cancel the Run and then fails the response at the network level; later dispatches would be accepted.
- When: The member sends a prompt with `POST /api/chat/events`; during the first dispatch the member calls `POST /api/runs/:id/cancel`.
- Then: The cancel returns HTTP 200, the Runner receives exactly one dispatch, and the Run is `cancelled`.

## runners-direct-dispatch-015

- Vitest: "switches candidates only after a definite refusal"
- Mode: run
- Given: A signed-in Pro member's Runner group has two official Runners; whichever is offered first answers `rejected` and the next answers `accepted`.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. Exactly two dispatches reach two distinct Runners, and the runner read returns the second Runner visited.

## runners-direct-dispatch-016

- Vitest: "tries every capacity-ranked candidate with the same prepared execution input"
- Mode: run
- Given: A signed-in Pro member's Runner group has three official Runners advertising (4 vCPU, 32,768 MB, capacity 8), (16 vCPU, 4,096 MB, capacity 8) and (16 vCPU, 32,768 MB, capacity 3). Only the second accepts; the others answer `rejected`.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running`. Dispatches are offered in the order third, first, second, all with an identical execution context and the same `notAfter` deadline, and the runner read returns the second Runner.

## runners-direct-dispatch-017

- Vitest: "dispatches to advertised unlimited capacity"
- Mode: run
- Given: A signed-in Pro member's Runner group has one official Runner advertising unlimited capacity (row `unlimited`: max concurrent 0, 100 running, 0 vCPU and 0 MB allocated).
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running` and the runner read returns that Runner's ID and heartbeat generation.

## runners-direct-dispatch-018

- Vitest: "dispatches to advertised reclaimable capacity"
- Mode: run
- Given: A signed-in Pro member's Runner group has one official Runner advertising reclaimable capacity (row `reclaimable`: max concurrent 2, 2 running, 8 vCPU and 16,384 MB allocated).
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running` and the runner read returns that Runner's ID and heartbeat generation.

## runners-direct-dispatch-019

- Vitest: "keeps another group's serving process when a heartbeat observes a later clock"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official Runner that heartbeated at the current time. A Runner in a different group then heartbeats with a clock just over five minutes later, and the clock returns to the original time.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The Run is `running` on the member group's Runner (the runner read returns its ID and heartbeat generation), and the Run completes through the public sandbox callbacks.

## runners-direct-dispatch-020

- Vitest: "selects a fresh serving process after stale, unavailable and untrusted-host observations"
- Mode: run
- Given: A signed-in Pro member's Runner group has a Runner whose last serving heartbeat is over 180 seconds stale, a Runner on an untrusted host, Runners with inactive ingress, `draining` mode or no admittable profiles, a Runner in an unrelated group, and one current Runner (generation 2, sequence 2). Replayed heartbeats for the current Runner then arrive with an older sequence or older generation in `starting` mode.
- When: Those heartbeats post to `POST /api/runners/heartbeat`, then the member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The heartbeats return HTTP 200, the Run is `running`, and the runner read returns the current Runner's ID and heartbeat generation 2.

## runners-direct-dispatch-021

- Vitest: "launches the following queued input after a definite refusal releases its Thread"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official Runner that refuses the first dispatch with `rejected` after the member queues a follow-up prompt into the same Thread, and accepts later dispatches.
- When: The member sends a first prompt with `POST /api/chat/events`; during its dispatch a second prompt is sent to the same Thread, then the member reads the Thread events, the follow-up Run and `GET /api/runs/queue`.
- Then: The first Run is `failed`. The follow-up input is promoted to a Run that is `running`, and the queue reports one active Run.

## runners-direct-dispatch-022

- Vitest: "preserves a concurrent cancellation after the process proves it did not accept"
- Mode: run
- Given: A signed-in Pro member's Runner group has an official Runner that, while handling the dispatch, has the member cancel the Run and then answers HTTP 429 `busy`.
- When: The member sends a prompt with `POST /api/chat/events`; during dispatch the member calls `POST /api/runs/:id/cancel`, then reads `GET /api/runs/queue`.
- Then: The Run stays `cancelled` and the queue reports zero active concurrency.

## runners-direct-dispatch-023

- Vitest: "definite refusal releases a preselected Run even though startedAt is set"
- Mode: run
- Given: A signed-in Pro member's Runner group has one official Runner that answers every dispatch with `rejected`.
- When: The member sends a prompt with `POST /api/chat/events` and reads `GET /api/runs/queue`.
- Then: The Run is `failed` with `failureReason` `unknown`, and the queue reports zero active concurrency.

## runners-direct-dispatch-024

- Vitest: "waits through short preferred-process 429s before using a roomier candidate"
- Mode: run
- Given: A signed-in Pro member completed a first `claude-fable-5-1` Run on a capacity-1 Runner, which becomes the Thread's preferred process. That Runner now answers its first two dispatches with HTTP 429 `busy` and then accepts; another Runner would accept any dispatch.
- When: The member sends a follow-up prompt to the same Thread with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The follow-up Run is `running`. The preferred Runner receives three byte-identical dispatches, the other Runner receives none, and the runner read returns the preferred Runner's ID and heartbeat generation.

## runners-direct-dispatch-025

- Vitest: "advances when preferred busy pressure outlasts its preference without renewing delivery"
- Mode: run
- Given: A signed-in Pro member completed a first `claude-fable-5-1` Run on a capacity-1 Runner, which becomes the Thread's preferred process. That Runner now answers HTTP 429 `busy` while the clock advances 2 seconds; another Runner accepts.
- When: The member sends a follow-up prompt to the same Thread with `POST /api/chat/events` and reads `GET /api/runs/:id/runner`.
- Then: The follow-up Run is `running`. Exactly two dispatches occur (one per Runner) with the same `notAfter` deadline, and the runner read returns the alternative Runner's ID and heartbeat generation.
