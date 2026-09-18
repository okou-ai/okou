# Morning Brief native scheduling, ownership and rollback

This is the durable state that lets a Morning Brief run without the legacy
Official Workflow scheduler, and the protocol that moves a member between the
two implementations in both directions without ever letting both own the same
occurrence.

It covers `morning_brief_native_schedules`,
`morning_brief_native_occurrences`, the
`/api/cron/execute-morning-briefs` tick, and every writer that may change a
member's choice, schedule or execution ownership.

**This is not a production rollout.** `simpleMorningBrief` stays registered off
with no allowlist, and the hard pre-activation gates are listed at the end.

## The two rows

### `morning_brief_native_schedules`

One row per member. It is the first Morning Brief row that is **authority**
rather than cache, and it carries four separable things:

| Concern               | Columns                                           |
| --------------------- | ------------------------------------------------- |
| Logical user choice   | `enabled`, `cron_expression`, `timezone`          |
| Scheduling obligation | `next_run_at`, `schedule_owner`                   |
| Execution ownership   | `phase`, `target`, `owner_epoch`, `membership_id` |
| Destination           | `agent_id`, `chat_thread_id`                      |

`legacy_workflow_id` and `legacy_automation_id` are **migration lineage**. They
are how the drain finds the old path's work. They are never native admission
authority: once a member is `native`, admission must keep working with the
legacy scheduler disabled and with no live Official Workflow installation or
catalog reconciliation.

`schedule_owner` is null exactly when `next_run_at` is null. An enabled member
is never left at `next_run_at = NULL` with nobody able to settle it — every
path that takes the obligation away either hands it to a claimed occurrence
that owes exactly one settlement, or installs a successor in the same
transaction.

### `morning_brief_native_occurrences`

One row per claimed slot, keyed by **owner + frozen scheduled anchor**. That
identity is what makes a slot deduplicable across overlapping ticks, worker
death and restarts. A new source set, prompt revision or result-schema version
is provenance recorded on the generation row; it is never a second occurrence
row and never a second model request for the same slot.

`generation_attempt_id` is uniquely indexed, so one reserved generation attempt
can belong to at most one slot.

## Phases

```
legacy ──▶ draining ──▶ native ──▶ rollback-draining ──▶ legacy
```

Those four edges are the only legal ones. There is no direct
`native → legacy` edge: turning the implementation switch off while native work
exists enters or continues `rollback-draining` and never reopens legacy
alongside that work. Repeated flips converge on the current `target` without
opening both owners or manufacturing extra epochs.

`owner_epoch` is bumped by every revocation or transfer. Work admitted under an
older epoch can still be _reconciled_, but can never deliver, settle the
schedule, or be resurrected by a later re-enable.

## Lock order

A writer that touches both the legacy automation and the native row takes:

1. the member's Morning Brief preference/admission **advisory lock** when the
   operation has one (`morning_brief_preference:<org>:<user>`),
2. the `morning_brief_native_schedules` row `FOR UPDATE`,
3. the selected `workflow_automations` row `FOR UPDATE`,
4. the exact S7a claim, Run, or callback row when the operation owns one,
5. any `morning_brief_native_occurrences` row `FOR UPDATE`.

Nothing else is permitted. External preflight — Clerk, Slack, the model
provider — happens **outside** short transactions, and the transaction
re-reads every predicate it depends on before it commits. Each mutation's
`WHERE` carries the epoch (and, for transitions, the phase) it read, so a stale
compensation cannot restore an older epoch's state over a newer writer.

## Writers

| Writer                                    | Effect on the native row                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| Settings enable / disable                 | Logical choice; `enabled` change bumps the epoch (revocation) |
| Settings / system timezone update         | `timezone` only. **No epoch bump, no revocation**             |
| Schedule-expression update                | `cron_expression` only. **No epoch bump, no revocation**      |
| Enrollment adoption / materialization     | Bootstrap insert only; an existing row is authority           |
| Generic automation enable/disable/update  | Logical choice, same rules as Settings                        |
| Official reconciliation pause / restore   | Configuration/readiness only; durable choice is preserved     |
| Thread or Agent deletion, membership loss | Revocation: epoch bump, obligation cleared, drain recorded    |
| Native cron claim                         | Takes the obligation; owes exactly one settlement             |
| Native settlement                         | Installs the next obligation from the **current** recurrence  |

### Selected legacy writers are schedule-first

Once a Morning Brief is materialized into the native schedule row, that row is
the authority even while `phase = legacy`. Every legacy reconciliation, S7a
claim, pre-run failure and callback transaction locks the native row before the
legacy automation. Claims must consume the exact durable legacy-owned anchor.
Settlements mirror the exact successor and the three-failure pause into both
rows atomically.

Reconciliation carries a composite fence across transaction boundaries:
phase, target, epoch, enabled choice, cron, timezone, obligation owner and
instant, legacy lineage, and row version. A changed field makes finalize or
compensation stale. Reconciliation may converge retained configuration, but it
can publish legacy recurrence only in `legacy`; `draining`, `native`, and
`rollback-draining` force legacy admission closed. A late journalled callback
may settle only its exact drain fact, while an unjournalled callback after
cutover is a no-op.

Removing and recreating the Blueprint retains the durable legacy automation ID
and samples the current durable choice at finalization. A Settings write that
lands after reservation therefore wins; recreation and rollback cannot replay
the older retained choice.

### Timezone and cron edits do not revoke in-flight work

This is deliberate and load-bearing. An edit that arrives while an execution
holds the obligation leaves the epoch, the frozen anchor and the frozen
reporting window alone. The execution's single settlement then computes the
next occurrence from the **current persisted** cron and timezone, which is how
the edit takes effect. Bumping a global epoch here would reject the only
callback responsible for scheduling again.

### Disable / re-enable never replays

Disabling bumps the epoch and clears the obligation, which invalidates every
slot admitted under the old epoch. Re-enabling bumps again and schedules the
next **future** occurrence from the re-enable clock. The revoked slot is never
replayed by `enabled: true → false → true`.

## Settlement matrix

Exactly one durable settlement per claimed slot advances the member's schedule.
Email completion is never that clock.

| Observed state                                  | Outcome              | Delivery obligation |
| ----------------------------------------------- | -------------------- | ------------------- |
| Collection completed and empty                  | `empty-skip`         | none                |
| Collection failed, incomplete, or exhausted     | `collection-failed`  | none                |
| Model returned a validated no-content decision  | `model-skip`         | none                |
| Known terminal generation failure               | `generation-failed`  | none                |
| Provider may have been invoked, outcome unknown | `generation-unknown` | none                |
| Accepted result                                 | `delivered`          | **pending**         |
| Configuration deferral exhausted                | `not-configured`     | none                |
| Choice, owner, membership or epoch revoked      | `revoked`            | none                |

`collection-failed` is never recorded as a healthy empty day, and
`generation-unknown` never claims zero cost. A transient failure settles the
slot and schedules the next occurrence; it never auto-disables the member's
Morning Brief.

### Pre-reservation configuration deferral

A slot that cannot execute because its configuration is momentarily missing is
deferred at most **3 times, 15 minutes apart** (`NATIVE_CONFIGURATION_DEFER_LIMIT`,
`NATIVE_CONFIGURATION_DEFER_MS`). Once exhausted it settles as
`not-configured` and schedules the next future occurrence. No hot loop, no
provider call, no false invocation receipt, and no enabled owner left with an
unowned `NULL` schedule.

### Bound-attempt recovery

S5 binds `generation_attempt_id` and sets `delivery_pending` in the reservation
transaction, before the sole provider POST. Recovery therefore owns two forms
of the same durable obligation: an accepted result whose native slot already
settled with delivery pending, and a process interruption after a bound S5
attempt committed but before native settlement. A bound attempt is never
reachable through ordinary occurrence resume, so neither form can recollect or
open a second invocation.

The consumer resolves the **durable S6 receipt by the native occurrence
identity first**, without requiring the S5 result to still be present. A Chat
receipt committed before a crash stays delivered after the result expires or
is physically purged, and its shared-outbox email recovery remains with S2.

Without a receipt, recovery consults S5's content-free readback for that exact
attempt:

- a retained accepted `deliver` result alone enters S6 under current authority;
- a validated model skip settles `model-skip`;
- `provider_failed`, `output_rejected`, `not_invoked`, and `result_discarded`
  settle `generation-failed`;
- `invocation_outcome_unknown`, a lapsed reservation, or a conclusively missing
  result settles `generation-unknown`;
- a live reservation and a temporarily unreleasable accepted result stay
  pending.

Logical retention does not erase known terminal metadata while its row still
exists. Physical deletion does make a receipt-less result unknown. A lapsed
reservation transition is fenced by that exact attempt, so a replacement row
cannot inherit the old attempt's unknown outcome. Closing is a compare-and-set
over the exact occurrence epoch, lease, bound attempt and pending flag. It locks
the schedule before rechecking the S6 receipt, so a delivery that commits while
recovery waits still wins as `delivered`; overlapping ticks can consume the
obligation once, and an old epoch cannot rewrite a newer schedule obligation.
Neither recovery path changes platform receipt/cost facts, reparses provider
output, or settles the schedule twice.

### Missed ticks coalesce

A claim takes the single `next_run_at` anchor and its settlement computes the
next occurrence from the settlement clock. A long outage therefore produces one
brief, not a burst of old daily generations. If a future unconsumed obligation
is already authoritative, settlement does not overwrite it.

## Drain

`proveLegacyMorningBriefDrain` reads the real S7a schedule-claim journal, which
records the exact scheduled anchor with its queue-event and Run bindings.

- An **unsettled** journalled claim keeps the drain unresolved. A lapsed lease,
  an empty outbox, a completed agent status and one 15-minute TTL are **not**
  proof.
- A member with **no journal rows at all** has unknown historical identity. The
  journal only starts recording at S7a's deployment, so an anchor is never
  reconstructed from `firedAt`, a Run context, an automation title or a TTL.
  Instead, the drain reads the actual automation queue events, Runs, callback
  rows and shared-outbox intents. It stays draining while any producer remains
  reachable, and may transfer only after all of those concrete rows are
  terminal. The historical identity limit remains explicit; absence of a
  journal is never treated as an invented occurrence.
- A journalled queue binding that is still unconsumed, a live Run, a pending or
  failed result callback, or an unsent mail intent keeps the drain unresolved
  even when the claim itself is settled.
- Only a member whose journalled claims and actual reachable legacy producers
  are all terminal is proven drained.

A held drain records a bounded reason in `drain_unresolved_reason` and keeps an
owned retry obligation. `drain_deadline_at` is an operational reporting signal;
expiry never advances the phase.

Rollback restores legacy from the **current** logical preference, timezone and
cron, and the next future unconsumed slot — never an old S3a copy and never the
original enabled bit. If Official reconciliation has temporarily paused, removed
or superseded the retained automation, rollback stays `rollback-draining` with
`legacy-target-not-ready`; it transfers only after locking a `current` row, then
writes that row from the durable current choice. Occurrence rows are not deleted on revocation:
content-free deduplication and drain facts must outlive content retention.

## The cron

`GET /api/cron/execute-morning-briefs`, registered in `ROUTES`, in the API
contract, and in `turbo/apps/api/vercel.json` at `* * * * *`. It uses the normal
`CRON_SECRET` bearer check; invalid authentication returns before any state read,
any write and any provider call.

One tick is bounded: 25 due owners, 25 delivery recoveries, 25 drain reports, and
an absolute 45-second budget after which it returns `budgetExhausted: true`. It
holds no transaction across a provider call and never sleeps inside the request.

It creates **no agent Run, sandbox, tool loop, Run-credit admission or ledger
debit**. Zero user or organization credits and a fully occupied agent-run queue
cannot block it.

## Deployment compatibility

The two tables, production generation-purpose constraint and delivery
`native_owner_epoch` are additive in generated migration
`1164_odd_victor_mancha`. There is no backfill and no source or history rewrite.

- **Migration before code.** Two unread tables. Every existing reader and writer
  is unchanged; Settings continues to answer from the live legacy state.
- **Old code after migration.** Old binaries do not know `phase`, `owner_epoch`
  or `membership_id`. They keep writing the legacy automation exactly as before.
  Because materialization only bootstraps a `legacy` phase row and never moves
  the obligation, an old binary and a new one disagree about nothing that is
  live.
- **New code before migration.** The tick's queries reference these tables
  unconditionally, so the migration must be applied before the new binary
  serves the cron path. A disabled feature switch does **not** hide that SQL:
  the switch gates admission inside the tick, not the table references. Deploy
  the migration first.

Every old Settings, scheduler, queue, runner, callback and outbox version that
ignores `phase` and `owner_epoch` must be drained or concretely fenced before
activation. A normal green CI merge does not satisfy that gate.

## Hard pre-activation gates

This PR is explicitly an **incomplete product rollout candidate**.

1. All five sources — Gmail, Calendar, GitHub, Chat and Slack — must compose
   into the **same single** generation invocation, preserving one stable
   production occurrence identity when they are added.
2. Legacy language preservation must be validated.
3. Every mixed-version Settings, scheduler, queue, runner, callback and outbox
   writer that ignores native phase/epoch must be drained or concretely fenced.
   Preview routes remain production-disabled and a preview result may never be
   promoted to a production result.
4. Parent S8 must supply the exact release, cohort, production and rollback
   evidence. S9 legacy removal stays separate.
