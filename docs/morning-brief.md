# Official Workflow Morning Brief

Morning Brief runs through the Official Workflow `daily-delivery` automation.
This document describes its current ownership, preference and scheduled-occurrence
contracts, not the retired Native replacement pipeline.

`workflow_automations` owns the enabled choice, recurrence and next-run anchor.
`morning_brief_enrollments` records explicit installation intent and the
Settings-managed workflow identity. `morning_brief_schedule_claims` is the
retained Official execution journal. None of these roles depends on the seven
retired Native tables or their former installed-preference projection.

## Installation ownership

A member can legitimately have Morning Brief installations on several Agents.
Settings manages exactly one:

- Prefer the existing installation named by the member's enrollment.
- If that identity is absent or no longer installed, select the installation on
  the organization's usable default Agent, otherwise the oldest installation.
  A default Agent that is private to another user is not usable.
- Changing the organization's default Agent does not move an installation that
  the enrollment already owns.
- Additional installations are reported as inventory. The ownership reader does
  not adopt, pause, rewrite or delete them.

An enrollment in `completed` state records ownership, not today's enabled state.
The selected automation owns whether delivery is enabled. A `cancelled`
enrollment is an explicit opt-out, not missing installation evidence to repair.

The destination thread is the canonical `workflow_user_automation_threads`
binding for the same organization, user and workflow. Never infer it from a
thread title or another owner's context. A null binding is normal before the
first delivery; reading it must not create a thread. Thread deletion pauses the
associated automation rather than creating a replacement delivery destination.

## Canonical state reader

[morning-brief-migration-state.service.ts](../turbo/apps/api/src/signals/services/morning-brief-migration-state.service.ts)
retains its existing identifier but is a current Official state reader, not a
migration executor.

- `loadMorningBriefOwnership$` returns the enrollment, the member's installations
  in oldest-first order and the selected installation.
- `loadMorningBriefMigrationState$` composes ownership, automation and thread
  reads into one of the states below.
- `loadMorningBriefDefaultAgentId$` resolves the usable default Agent for
  installation selection and Settings availability.

| State          | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `absent`       | The member owns no Morning Brief installation.                |
| `pending`      | The selected installation has not finished installing.        |
| `installed`    | The selected installation owns one valid Official automation. |
| `inconsistent` | An installed workflow fails an automation invariant.          |

A valid automation is the unique owner-scoped cron schedule with blueprint
`daily-delivery`, reconciliation status `current` and result email enabled.
Missing or multiple automations, an unexpected schedule, unfinished
reconciliation or disabled result email produce an explicit inconsistency.
An `installed` state may itself be enabled or paused.

Every state carries the owner, enrollment and additional installations.
Installation-bearing states also carry the selected installation and nullable
thread binding. The internal installed view includes automation identity,
enabled state, cron expression, timezone and next-run anchor; it is not the
public preference response.

These commands read their own database and accept a final `AbortSignal`. They do
not write, install, repair, backfill or create a thread. Dependency errors
propagate instead of becoming `absent`. The composed result is **not a
transactional snapshot**: consumers acting on it must use the existing
conditional writers and re-read after writes, not add a lock around the entire
reader.

## Explicit installation and preferences

Users install through the Official Workflow catalog or explicitly enable the
Morning Brief preference. Preference reads, timezone updates, onboarding and
membership creation do not automatically install it. The workflow cron does not
scan historical members or retry pending enrollment intent in the background.

Enabling requires a valid timezone and a usable Agent. An explicit choice made
before prerequisites are ready remains recorded; the user repeats enable after
supplying them. A dependency failure is not permission to install or enable a
replacement. Existing installations, explicit opt-outs and additional
installations remain intact.

[morning-brief-preference.service.ts](../turbo/apps/api/src/signals/services/morning-brief-preference.service.ts)
projects the canonical state onto Settings. The public response exposes
`enabled`, `status` and `unavailableReason`, not the reader's internal schedule
and thread inventory. An inconsistent installed state is a conflict, not an
empty preference.

Preference mutations record the explicit choice, re-read current ownership and
use the conditional Official automation writer. The automation toggle commits
its enabled bit and, for a user-owned toggle, enrollment choice together. A
concurrent change reports a conflict rather than overwriting a newer lifecycle.
Enrollment completion is conditional so a cancelled choice wins. Timezone
synchronization does not silently enable a paused automation.

## Scheduled occurrences and settlement

The selected, installed, reconciled Morning Brief cron automation is journaled.
Additional installations, manual runs and other automation kinds are not
implicitly adopted into this canonical journal path.

Admission consumes the exact enabled Official anchor and records the claim
alongside its durable Chat queue event. It rechecks the 30-minute admission
boundary and refuses admission while an Official claim is unsettled. The Run
launch transaction binds the exact queue event to its first Run; the existing
binding is never reassigned to a later launch.

The claim records bounded identity and lifecycle metadata: automation, workflow,
nullable owner identity, frozen `scheduled_anchor_at`, actual `claimed_at`,
monotonic `claim_sequence`, queue-event and Run bindings, queue disposition and
settlement. Automation/anchor, queue-event, Run and per-automation sequence
uniqueness prevent duplicate identities. The sequence orders journaled
occurrences; it is not by itself a user-choice or schedule-replacement epoch.
No prompt, result, recipient, provider payload, credential or free-form error is
stored in this journal.

Run completion and pre-run failure use the shared settlement operation. Only
the current, exactly bound, unsettled claim can settle. Recurrence advancement
also requires the automation to remain enabled with an empty in-flight slot;
an already published successor is not overwritten. The conditional successor
write and claim settlement share rollback authority. Duplicate or superseded
callbacks do not advance the schedule again. Recurrence uses current schedule
configuration at settlement, not the old poll clock. Insufficient-credit failure
does not increment the failure count or disable the recurring automation.

An unjournaled compatibility callback may advance only a lineage without any
Official claim records. Losing or deleting a known claim must never turn it
into an untracked execution with new schedule authority.

### Future-only expiry

Morning Brief has a bounded expired-anchor lane independent of the general
workflow-expiry switch. An unclaimed anchor **strictly more than 30 minutes** old
can move only to a strictly future recurrence. Exactly 30 minutes late is still
within admission grace.

Expiry creates no historical Run, queue input, Chat result or email and does not
increment failures. An existing claim for the anchor, an unsettled Official
claim or pending unrevoked queue input holds recovery. A stale snapshot or
concurrent writer loses the conditional update without overwriting the winner.
Do not settle an unknown claim or replay a missed brief based on age alone.

### Journal lifetime and owner revocation

The journal is retained deduplication and callback history, not disposable
Native storage. Automation deletion cascades its claims. User, organization and
membership revocation instead scrub the affected claims' `org_id` and
`owner_user_id`, record terminal `revoked` settlement and retain the content-free
execution marker. A late callback therefore still recognizes the execution and
cannot resurrect it. Other owners' claims and automations are untouched.

## Email and retirement boundary

Ordinary `official-automation-result` mail keeps its shared result callbacks,
unsubscribe, suppression, retention and idempotent delivery lifecycle.
Historical Native `morning-brief-result` intents are rejected before rendering
or provider replay, including a request committed by an older API. Their queued
body and rendered request are scrubbed; the rejection preserves the distinction
between no prepared request and an unresolved provider outcome. Owner cleanup
purges retired unsent intents directly from the shared outbox without Native
delivery-table joins. Completed mail and other templates are not purged by that
retired-intent cleanup.

Rejection or local deletion does not prove an earlier provider request was never
accepted. Keep anonymous `morning_brief_platform_generation_receipts`, including
unknown outcomes; do not retry historical model requests or erase accounting
evidence to make retirement look complete.

Native runtime and storage retirement are complete. Historical migration SQL
remains permanent history; the seven-table drop does not remove Official
workflows, enrollment, claims, workflow skip history, Chat or ordinary email.
The [deployment contract](deployment-compatibility.md#native-morning-brief-storage-contraction-2026-10-07)
records the incompatible old-API and rollback boundary. This functional document
does not authorize an old binary rollback or certify every historical missed
slot's delivery.

## Implementation references

- [Canonical state reader](../turbo/apps/api/src/signals/services/morning-brief-migration-state.service.ts)
- [Preference operations](../turbo/apps/api/src/signals/services/morning-brief-preference.service.ts)
- [Official automation toggle](../turbo/apps/api/src/signals/services/morning-brief-automation-toggle.service.ts)
- [Canonical claim and settlement](../turbo/apps/api/src/signals/services/morning-brief-schedule-claim.service.ts)
- [Claim admission and journal SQL](../turbo/apps/api/src/signals/services/workflow-schedule-queue.service.ts)
- [Exact queue-event / Run binding](../turbo/apps/api/src/signals/services/pending-launch-claim-plan.ts)
- [Expired-anchor recovery](../turbo/apps/api/src/signals/services/workflow-schedule-expiry.service.ts)
- [Claim schema](../turbo/packages/db/src/schema/morning-brief-schedule-claim.ts)
