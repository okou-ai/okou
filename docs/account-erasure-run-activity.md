# Account erasure: activity copies (B2b2-R1)

Scope: [#34434](https://github.com/vm0-ai/okou/issues/34434), one activity family
under [#33745](https://github.com/vm0-ai/okou/issues/33745). This consumes the
accepted [run-content ownership barrier](account-erasure-run-output.md).
It does not complete B2, authorize deletion, or establish A2/H readiness.

## Entry points and transaction boundaries

| Entry                                                                                             | Actual guarded transaction                                                                       | Ownership pin                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Agent events webhook and Pi API-first output -> required output -> optional dispatcher -> capture | Snapshot INSERT/update, revision, 24-hour expiry and expired summary/claim reset                 | Complete ownership returned by the successfully committed required-output transaction |
| Authenticated activity-summary route -> claim                                                     | Snapshot INSERT, bounded visible context, cursor/retention, 15-second claim and attempt interval | Complete persisted ownership, revalidated inside the committed claim                  |
| Auxiliary provider result -> completion/response                                                  | Conditional summary or 60-second cooldown update, claim clearing and existing-row response read  | Original claim ownership, with fresh admission and current-run eligibility            |

The internal pin includes run user/org/session/trigger, thread identity and
owner/agent, session owner/org/agent, applicable Agent owners/orgs, and private
memory mount/Storage ownership. It is recursively frozen, transient, and never
part of public/Guest schemas, logs, provider prompts or persisted copies.
It fixes the identity of prepared content; it grants no ongoing admission.
The two existing callers of `receiveAgentEvents$` pass its inferred accepted
result to the optional dispatcher; neither needs a public contract change.

Every activity content transaction uses the existing complete order:
**sorted subjects -> resources -> thread -> run -> session -> snapshot**. The
exact run row is the common same-run mutex before activity work begins. Each
transaction revalidates the pin and destination, then checks pending/running and
the thread's current-run pointer while those rows are locked. A closure that wins
prevents all snapshot/claim/cooldown/expiry writes and old-content responses. An
admitted transaction commits before closure can project. Ownership changes never
reassign prepared content to a survivor. Auth, feature-disabled and initial
not-found responses precede the guard; an otherwise valid closed request gets
the existing empty `ineligible` response, without exposing account state.

The only new deadline profile is the internal `activity` choice: **250ms lock /
3s statement**. Existing output, callback and acknowledgement callers retain
**1s / 5s** defaults. There are no nested transactions, subject locks after
snapshot locks, new classification queries, isolation changes or arbitrary
caller timeout values. Initial ownership discovery uses the same activity profile.

## Provider and error semantics

A committed summary claim admits one finite auxiliary operation. Its existing
10-second provider deadline and request cancellation remain; no database locks
cross the provider request. Closure before claim prevents a provider call.
Closure after claim may occur after content has already been sent. Fencing the
completion and response cannot recall that egress. Existing auxiliary telemetry
and provider copies remain G2/drain obligations, without a new retention exception.

Capture remains best effort: lock timeout, missing run and FK deletion races are
silent; other failures retain safe SQLSTATE-only diagnostics. Exact PostgreSQL
`55P03` from a rolled-back claim or combined completion/response transaction
returns the empty `unavailable` response without retrying or replaying the model.
The combined transaction reads only the actual existing snapshot after its
conditional update; a missing or expired row is unavailable and is never
recreated for the response. Other summary storage failures propagate normally,
and request cancellation retains its original error without charging another
viewer's cooldown. Same-owner concurrent claims, revision/retry behavior,
intervals and retention keep their existing semantics. Admitted required output,
ACK, billing and other optional consumers are unchanged.

Expiry maintenance keeps its existing indexed, ordered, **500-row SKIP LOCKED
DELETE**. It does not create content and has no writable-account gate. Closed
accounts remain eligible for cleanup, including when another expired row is held.

## Verification boundary

The existing real-PostgreSQL/B1 infrastructure suite creates uniquely owned
accounts, agents, threads and runs through APIs. The actual optional dispatcher
and authenticated summary route exercise capture, claim and combined
completion/response transactions. Dormant B1 has no
production deletion ingress; held locks, ownership transfers, collector removal,
SQLSTATE/settings inspection and delayed delivery of a real COMMIT therefore use
explicit infrastructure fixtures. The pg fixture forwards original queries,
results and errors unchanged and pauses only a transaction containing its unique
run. Deferred provider responses and observed PostgreSQL blockers establish
commit order; no sleeps infer races and no admission/business helpers are mocked.
Completion and response construction share one freshly admitted transaction, and
the API returns its stored response only after that transaction commits.

Route regressions cover auth/feature gates, concurrency, TTL, claim expiry,
revision retry, current-run changes, provider failure/invalid output/deadline,
request cancellation and cleanup. Output/terminal/admitted billing coverage is
rerun because the shared guard and accepted-result handoff changed.

No schema, migration, backfill, full-table scan, production test, activation or
release is included. The controller's approved 130-table MaskDB discovery does
not expose `run_activity_snapshots`; its live size/state remain unknown. No
policy or credential expansion is requested. The recovered September 12 account
is excluded. Only minimal platform billing is retained; independent survivors
and last-member organization/billing disposition remain governed by the EPIC.
