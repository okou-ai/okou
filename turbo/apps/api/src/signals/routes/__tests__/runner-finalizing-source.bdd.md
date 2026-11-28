# runner-finalizing-source

## runner-finalizing-source-001

- Vitest: "Independent finalizing resource dispatch > routes previous-Run sandbox independently of native history"
- Mode: run
- Given: Row `sandbox`: a chat user's thread run failed on Runner A (generation 7) without reporting native initialization. 2.5 seconds later Runner A's heartbeat lists that run as an active reuse producer and holds a reusable sandbox from an unrelated run, while a newly registered Runner B holds the thread's reusable sandbox from the failed run.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner B. The dispatched execution has a native continuation with null session ID and generation run ID and a recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`.

## runner-finalizing-source-002

- Vitest: "Independent finalizing resource dispatch > routes previous-Run home independently of native history"
- Mode: run
- Given: Row `home`: a chat user's thread run failed on Runner A (generation 7) without reporting native initialization. 2.5 seconds later Runner A's heartbeat has no active producer and holds an unrelated reusable sandbox, while a newly registered Runner B holds the thread's `vm0/default` Home cache from the failed run (and a `vm0/large` Home from it).
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner B. The dispatched execution has a native continuation with null session ID and generation run ID and a recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`.

## runner-finalizing-source-003

- Vitest: "Independent finalizing resource dispatch > routes previous-Run other-profile-home independently of native history"
- Mode: run
- Given: Row `other-profile-home`: a chat user's thread run failed on Runner A (generation 7) without reporting native initialization. 2.5 seconds later Runner A's heartbeat has no active producer, while Runner B holds the thread's `vm0/default` Home from an unrelated run and only a `vm0/large` Home from the failed run.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on the original Runner A (generation 7). The dispatched execution has a native continuation with null session ID and generation run ID and a recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`.

## runner-finalizing-source-004

- Vitest: "Independent finalizing resource dispatch > keeps the completed Claude source after a native Codex framework switch"
- Mode: run
- Given: Row `completed`: a chat user's initialized Claude Code thread run completed on Runner A. The user then adds a Codex OAuth personal model provider; Runner A's heartbeat lists the run as an active reuse producer and a larger Runner B is registered.
- When: The user continues the same thread with model `gpt-6-astra` through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner A, and its execution uses CLI agent type `codex`.

## runner-finalizing-source-005

- Vitest: "Independent finalizing resource dispatch > keeps the cancelled Claude source after a native Codex framework switch"
- Mode: run
- Given: Row `cancelled`: a chat user's initialized Claude Code thread run was cancelled on Runner A (exit code 137). The user then adds a Codex OAuth personal model provider; Runner A's heartbeat lists the run as an active reuse producer and a larger Runner B is registered.
- When: The user continues the same thread with model `gpt-6-astra` through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner A, and its execution uses CLI agent type `codex`.

## runner-finalizing-source-006

- Vitest: "Independent finalizing resource dispatch > keeps the failed Claude source after a native Codex framework switch"
- Mode: run
- Given: Row `failed`: a chat user's initialized Claude Code thread run failed on Runner A (exit code 1). The user then adds a Codex OAuth personal model provider; Runner A's heartbeat lists the run as an active reuse producer and a larger Runner B is registered.
- When: The user continues the same thread with model `gpt-6-astra` through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner A, and its execution uses CLI agent type `codex`.

## runner-finalizing-source-007

- Vitest: "Independent finalizing resource dispatch > dispatches to a failed producer that never reported native initialization"
- Mode: run
- Given: A chat user's thread run failed on Runner A without reporting native initialization; Runner A's later heartbeat lists it as an active reuse producer and a larger Runner B is registered.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the continuation on Runner A (generation 7), and its native continuation has null session ID and generation run ID.

## runner-finalizing-source-008

- Vitest: "Independent finalizing resource dispatch > prefers a dispatchable Home holder when the exact sandbox holder cannot accept"
- Mode: run
- Given: A chat user's initialized thread run completed on Runner A, whose later heartbeat holds the thread's reusable sandbox but reports its ingress service inactive. A large Runner B with free capacity and a single-slot Runner C holding the thread's Home cache from that run are registered.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running`, and `GET /api/runs/:id/runner` shows it on Runner C with Runner C's heartbeat generation.

## runner-finalizing-source-009

- Vitest: "Independent finalizing resource dispatch > routes to a same-host replacement while its predecessor drains"
- Mode: run
- Given: A chat user's initialized thread run completed on Runner A, whose heartbeat reports `draining` mode with the run as an active reuse producer. A single-slot replacement Runner (generation 8) with the same hostname and a large alternative Runner are registered, and the clock advances 2 seconds.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running`, and `GET /api/runs/:id/runner` shows it on the same-host replacement Runner with its heartbeat generation.

## runner-finalizing-source-010

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with active-producer"
- Mode: run
- Given: Row `active-producer`: a chat user's completed thread run's Runner A reports `draining` 26 minutes later with the run as an active producer. A single-slot same-host replacement Runner answers the first dispatch as busy (HTTP 429, invalid timing header) and the retry as accepted with a valid timing header; a large alternative Runner is also registered.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the replacement Runner. The replacement receives two byte-identical dispatches carrying a preferred Home checkout for the predecessor run whose wait deadline is within 1 second of sending and before `notAfter`; the alternative Runner receives no dispatch.

## runner-finalizing-source-011

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with drain-release"
- Mode: run
- Given: Row `drain-release`: a chat user's completed thread run's Runner A reports `draining` 26 minutes later with no active producer. A single-slot same-host replacement Runner answers the first dispatch as busy (the clock advances 492 ms) and the retry as accepted; a large alternative Runner is also registered.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the replacement Runner. The replacement receives two byte-identical dispatches carrying a preferred Home checkout for the predecessor run with a wait deadline within 1 second and before `notAfter`; the alternative receives no dispatch.

## runner-finalizing-source-012

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with drain-expiry"
- Mode: run
- Given: Row `drain-expiry`: a chat user's completed thread run's Runner A reports `draining` 26 minutes later with no active producer. A single-slot same-host replacement Runner answers every dispatch as busy, advancing the clock past the preferred Home wait deadline; a large alternative Runner accepts.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the alternative Runner. The replacement receives two byte-identical dispatches with a preferred Home checkout for the predecessor run; the alternative receives exactly one dispatch without a Home hint and with the same `notAfter` deadline as the first preferred dispatch.

## runner-finalizing-source-013

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with stopping"
- Mode: run
- Given: Row `stopping`: a chat user's completed thread run's Runner A reports `stopping` mode 26 minutes later with no active producer. A single-slot same-host replacement Runner and a large alternative Runner both accept.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the replacement Runner, which receives exactly one dispatch without a preferred Home checkout; the alternative receives none.

## runner-finalizing-source-014

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with stale-drain"
- Mode: run
- Given: Row `stale-drain`: a chat user's completed thread run's Runner A reports `draining` 26 minutes later with no active producer, and the clock then advances a further 180,001 ms. A single-slot same-host replacement Runner and a large alternative Runner both accept.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the replacement Runner, which receives exactly one dispatch without a preferred Home checkout; the alternative receives none.

## runner-finalizing-source-015

- Vitest: "Independent finalizing resource dispatch > bounds Home dispatch and same-byte retry with different-generation"
- Mode: run
- Given: Row `different-generation`: a chat user's completed thread run's Runner A reports `draining` 26 minutes later under snapshot generation 8 with no active producer. A single-slot same-host replacement Runner and a large alternative Runner both accept.
- When: The user continues the same thread through `POST /api/chat/events`.
- Then: The continuation is `running` on the replacement Runner, which receives exactly one dispatch without a preferred Home checkout; the alternative receives none.

## runner-finalizing-source-016

- Vitest: "Independent finalizing resource dispatch > keeps another Chat's producer out of a new Thread's placement"
- Mode: run
- Given: A chat user's thread run failed on Runner A without native initialization. The user creates a separate chat thread, Runner A's heartbeat lists the failed run as an active producer keyed to that new thread, and a large Runner B is registered.
- When: The user starts the first run in the new thread through `POST /api/chat/events`.
- Then: `GET /api/runs/:id/runner` shows the run on Runner B with its heartbeat generation, and the execution is marked as the first run.

## runner-finalizing-source-017

- Vitest: "Independent finalizing resource dispatch > selects an advertised Home at the snapshot bound and clears it after an empty snapshot"
- Mode: run
- Given: A chat user has two new chat threads. Runner A's heartbeat (sequence 2) advertises 4096 Home states with the first thread at the last position and the second at the next-to-last; a later stale heartbeat with sequence 1 reports no Homes. A large Runner B is registered.
- When: The user starts a run in the first thread via `POST /api/chat/events`; the sandbox completes it with exit code 1; Runner A then heartbeats sequence 3 with no Homes; the user starts a run in the second thread.
- Then: The first-thread run is `running` on Runner A. After the empty sequence-3 snapshot, the second-thread run is `running` on Runner B with its heartbeat generation.
