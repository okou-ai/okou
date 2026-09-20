# Single-thread metadata account-erasure admission

Scope: [#35319](https://github.com/vm0-ai/okou/issues/35319) and its
failure-path validation [#35329](https://github.com/vm0-ai/okou/issues/35329),
under [#33745](https://github.com/vm0-ai/okou/issues/33745). This records the
post-authentication database contract for
`GET /api/chat-threads/:id/metadata`. It adds no closure ingress, worker,
schema, writer, release action or production erasure operation.

## Authority and transaction boundary

The route keeps its existing `chat-thread:read` capability and exact thread-user
authorization. The currently selected organization and an active run are not
new requirements. A non-null Agent is required only because the successful
metadata response already requires its UUID; missing, foreign, Agent-less or
closed scope remains the same opaque `404 Chat thread not found`.

One bounded `READ COMMITTED` attempt owns canonical identity, B1 admission,
retained Agent/thread locks, the complete metadata projection and parsing, the
final operation-signal check and `COMMIT`:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`.
2. Transaction-local `lock_timeout = '1s'` and `statement_timeout = '5s'`.
3. Content-free thread/Agent identity by thread primary key.
4. Sorted, deduplicated B1 subjects: thread user, distinct Agent owner and Agent
   organization.
5. The first shared advisory lock and the READ COMMITTED isolation check in one
   folded `erasure_isolation_probe` statement, then one statement per remaining
   subject.
6. One exact closure lookup over all admitted `(subject_kind, subject_id)`
   pairs.
7. Agent primary-key `FOR KEY SHARE`, then thread primary-key `FOR UPDATE` as
   the first thread lock.
8. Canonical identity re-read and field-for-field comparison.
9. The fixed-column metadata projection by thread primary key, parsing model
   settings and preserving all existing null/value conversions.
10. Final operation-signal check and `COMMIT`; a movement retry or any other
    failure rolls the attempt back.

The first thread lock is `FOR UPDATE`, not a later upgrade from KEY SHARE. This
serializes same-thread metadata reads before they can acquire a later business
lock and remains compatible with unrelated owners. Closure admission still
precedes Agent and thread locks.

## SQL and control counts

The focused SQL-control suite observes unchanged driver statements after auth
and after test setup. Let `s` be the number of deduplicated subjects. The common
same-owner fixture has `s = 2` (thread user equals Agent owner, plus Agent
organization); a distinct shared-Agent owner has `s = 3`.

| Outcome                                            | Same owner (`s = 2`) | Distinct Agent owner (`s = 3`) | Evidence and limitation                                                                                                |
| -------------------------------------------------- | -------------------: | -----------------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Open metadata                                      |                   12 |                             13 | One complete successful transaction; the extra owner adds one shared-lock statement.                                   |
| Missing, foreign or Agent-less                     |                    5 |                              5 | `BEGIN`, two controls, identity lookup and `COMMIT`; no subject is admitted.                                           |
| Closed subject                                     |                    8 |                              9 | Stops after `s` lock statements plus the single closure lookup, then commits denial.                                   |
| Latest-stage changed-user retry followed by denial |          11 + 5 = 16 |                    12 + 5 = 17 | First attempt reaches locked identity recheck and rolls back; the second identity is unauthorized and commits missing. |

The executable suite pins the actual same-owner paths: 12 open, 5 missing, 8
closed and one 11-statement rollback plus 5-statement denial. It does not claim
that every movement happens at the latest stage. The helper permits at most
three whole attempts, but this fixture proves one bounded retry rather than a
worst-case production distribution. SQL timeout, deadlock, parse and abort
failures are not converted to `404` or retried by this ownership loop.

The identity read, re-read and retained locks use equality predicates on
`chat_threads.id` and `agents.id`, columns backed by `chat_threads_pkey` and
`agents_pkey`. The metadata projection uses the thread-id predicate and selects
only its explicit columns. The closure lookup uses exact subject predicates and
the `account_erasure_subject_generation`
`(subject_kind, subject_id, generation)` prefix with `LIMIT 1`.

The suite pins those predicate shapes, selected columns and returned-row limits;
it does not run `EXPLAIN` and therefore makes no claim that a particular plan
was selected, nor about physical rows or buffers scanned, production cardinality
or endpoint latency.
No new benchmark or production query is part of this slice.

## Response-size evidence

The complete success fixture covers all eleven response fields and serializes
to exactly **425 UTF-8 bytes** for its chosen UUIDs, ISO timestamp, title,
selected model, settings and pin values. UUID and ISO widths are stable in that
sample, but title, model and settings content is variable. The measurement is a
representative complete fixture, not a universal payload bound, physical-work
bound or transport-envelope size.

## Failure-path test ownership

Every concurrent metadata acceptance callback immediately observes each reader,
closure, mutation and holder result. Its local owner releases the selected
PostgreSQL statement, aborts only controllers registered to that scope and joins
all started branches on success and every callback exit. Expected failures are
accepted only after their exact error is asserted; otherwise operation failures
remain reportable, including together with a distinct callback error.

A concurrent synthetic closure registers teardown from its own result as soon
as it starts, before any barrier assertion or outer assignment can fail. The
read-first and closure-first deliberate-exit cases prove the actual blocker,
join both branches, remove the exact resulting job and then complete a healthy
production metadata GET. Readiness waits race the selected barrier against the
owned operation, so request failure or success before entry fails immediately
instead of waiting for a gate that cannot be reached. Setup abort, pre-entry
auth failure, post-projection operation abort and subsequent healthy reads are
covered with real PostgreSQL and the production route; no sleep, global lock,
production mock or ignored rejection substitutes for those outcomes.

## Residual boundary

This endpoint only fences one metadata read. It does not erase existing rows,
revoke an already delivered response, drain producers or capabilities, fence
other read/write surfaces, retain financial-connector business content as
billing, activate account closure, or satisfy the parent epic's publication and
production-verification gates.
