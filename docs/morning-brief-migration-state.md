# Morning Brief migration state

Morning Brief is being replaced by `simple-morning-brief`, a platform-funded
server-side pipeline
([#34637](https://github.com/vm0-ai/okou/issues/34637)). The replacement must
carry the user's existing brief forward without asking anyone to reinstall or
reconfigure it, so both the current Settings surface and the later migration
read one authoritative description of what a member owns today:
`morning-brief-migration-state.service.ts`.

This document records the invariants that reader encodes. It does not describe
the new pipeline, which does not exist yet.

## The exported contract

`loadMorningBriefOwnership(db, owner)` answers "which installation does this
member's preference surface manage?" and returns the enrollment row, every
Morning Brief installation the member holds (oldest first), and the selected
one. `loadMorningBriefMigrationState(db, owner)` composes the full view on top
of it and returns exactly one of:

| `kind`         | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `absent`       | The member owns no Morning Brief installation.              |
| `pending`      | The selected installation has not finished installing.      |
| `installed`    | The installation owns one valid Morning Brief schedule.     |
| `inconsistent` | The installation is installed but its schedule is not ours. |

Every state carries the owner, the enrollment, and
`additionalInstallations`. Installation-bearing states also carry the selected
installation and `chatThreadId`. An `installed` state carries the automation's
`enabled`, `cronExpression`, `timezone` and `nextRunAt`; an `inconsistent`
state carries which invariant failed.

`loadMorningBriefDefaultAgentId(db, owner)` resolves the Agent an org-wide
action would use, and backs both the adoption tie-break and the Settings
availability check.

## Ownership invariants

- **Settings owns exactly one installation.** The catalog installs Morning
  Brief per Agent, so holding several installations is a legitimate state. The
  enrollment records the one the preference surface manages. When that record
  is absent or stale — written before the column existed, or pointing at an
  installation that was later uninstalled — ownership falls back to the
  adoption rule: the installation on the org's current default Agent,
  otherwise the oldest. Changing the org default Agent does not move an
  installation the enrollment already owns.
- **Additional installations are inventory, not candidates.** They are
  reported so the migration can account for them. They are never adopted,
  paused, rewritten or deleted by this path, and they keep running on their own
  Agent.
- **Enrollment intent is not enabled state.** `morning_brief_enrollments`
  records a one-time installation intent. A `completed` enrollment only says
  which installation it bound; the delivery schedule owns whether the brief
  runs today, and an explicitly disabled automation stays disabled. An explicit
  opt-out (`cancelled`) is a user choice that migration must preserve rather
  than re-derive.
- **The thread binding is canonical.** The destination thread comes from
  `workflow_user_automation_threads` scoped to the same org, user and
  workflow — never from a thread title, and never from another owner. `null`
  means the brief has not delivered yet, which is normal before the first run,
  not a failed lookup. Deleting that thread pauses its automation; migration
  must not resurrect it.
- **Failure is not emptiness.** A read that throws propagates. Nothing in this
  reader converts a dependency failure into "no brief", and nothing here
  writes.

## Automatic enrollment retries

Initialization, onboarding, membership events and the enrollment worker share
the existing member advisory lock and durable enrollment retry fields. Intent
is recorded before checking the feature switch, timezone, default Agent and
accepted active workflow definition. Unknown eligibility is qualified once
against Clerk so historical members keep their ineligible preference state.
For a known eligible member, an unavailable local prerequisite does not repeat
that read or consume the external failure budget; the worker revisits it after
a minute, and an inline request can proceed as soon as the prerequisite arrives.

A first qualification or locally ready attempt claims a five-minute recovery
lease before reading current Clerk membership. Failed attempts retry after 1,
2, 4, 8, then at most 15 minutes, and inline requests honor the same deadline as
workers. Skipped requests do not extend an existing deadline. Explicit preference changes keep
their own immediate behavior. Membership qualification preserves its lease;
a new membership event or explicit choice invalidates an older retry writer.
Worker notifications follow enrollment state or error changes; unchanged local
deferrals do not repeatedly invalidate the preference shown in Settings.

Deletion records the departed membership generation even when enrollment has
not started or an earlier live lookup already marked the member departed.
Replayed creation of that generation cannot revive enrollment.
A different live generation can qualify on a later ready attempt, including
when its creation webhook was missed. Installation still checks current
membership; local prerequisites and retry state never grant authority.

These changes reuse the existing schema and HTTP contracts. Old browser
initialization requests remain supported, and mixed older API workers may
retain the previous retry behavior until rollout completes. Rollback does not
require a data migration.

## Reading it safely

`loadMorningBriefMigrationState` is a composed read, not a transactional
snapshot. Its parts can move between queries. Callers that act on the result —
enabling, disabling, installing, or eventually claiming an occurrence — must
invoke it inside the transaction or advisory lock that already guards that
mutation, exactly as the preference surface does today.

## Migration boundary

- The cutover owns state that outlives this read: the Settings-owned
  installation and its schedule, explicit opt-outs, the bound thread and its
  history, and the automation's email delivery policy. It must revalidate
  ownership, membership and the user's current choice at the delivery boundary
  rather than trusting a view composed earlier.
- Account selection must stay stable. The legacy path resolves the destination
  thread's explicit connector account before the org default; a migrated brief
  must resolve the same account and must not silently fall back to another one
  when an explicit account is missing or revoked.
- `FeatureSwitchKey.SimpleMorningBrief` (`simpleMorningBrief`) selects the
  implementation and is registered fully off, with no staff allowlist. It is
  independent of `MorningBrief`, which remains the user-facing availability
  switch: turning the implementation switch on must never change whether a user
  has Morning Brief, and turning it off must not discard choices the user made
  while it was on.

## The installed preference projection

`morning_brief_installed_preferences` holds at most one row per
`(org_id, user_id)`: a copy of the `installed` state above, written by the real
Settings writers and read back by the real Settings reader
([#34693](https://github.com/vm0-ai/okou/issues/34693)). It is a persistence and
serialization rehearsal for the native pipeline, **not** an authority, an
execution record, or a cache that makes anything faster. The legacy installation
and its automation still decide everything; the legacy queries all still run.

`FeatureSwitchKey.SimpleMorningBrief` gates both directions and is off by
default, so the production path is unchanged until it is turned on.

### What is copied, and when it may be used

The row stores `projection_version` plus the fields needed to reproduce and
check the managed installed state: the selected `workflow_id`, its
`automation_id` and `agent_id`, the bound `chat_thread_id`, `enabled`,
`cron_expression`, `timezone` and `next_run_at`. Nothing else — no source
bodies, prompts, results, credentials, usage or delivery attempts.

The Settings GET always loads and answers from the live canonical state first.
Only then, and only while the switch is on, may the projection supply the
response, and only when **every** field above still equals that live state and
`projection_version` is the version the reader understands. Anything else —
no row, an unsupported version, a different selected installation, a schedule
the scheduler advanced, a timezone an older binary changed — silently keeps the
legacy answer.

The row's own `updated_at` is not freshness evidence. Old API binaries, the
automation poller, catalog reconciliation and thread deletion all change the
legacy state without writing here, which is exactly why equality against a
freshly loaded state is the only accepted proof. GET itself never writes,
installs, repairs, backfills or creates a thread, and `absent`, `pending`,
`inconsistent` and pre-installation opt-out states never reach the projection at
all.

### Refresh is not atomic with the legacy write

Writers refresh the row after a successful preference update, after enrollment
completion or adoption, and after timezone synchronization. All three already
hold the preference advisory lock, so they serialize against each other, but
[that lock's transaction is not the legacy write's transaction](#reading-it-safely):
the legacy mutation runs on the outer `Db` and has already committed when the
copy starts.

The refresh therefore never pretends to be atomic. It re-reads the canonical
state inside its own bounded transaction, and if the copy fails, the failure is
reported operationally while the committed legacy outcome is still returned —
the user is not told a successful choice failed, and the mutation is not
replayed. A later read falls back to legacy and still shows that choice. An
expected skip (switch off, no installed brief, no membership parent) is recorded
separately from an infrastructure failure, so a failure is never recorded as a
healthy projection. Cancellation keeps propagating; a cancelled request does not
leave a detached write behind.

When the state is not `installed`, the refresh deletes the row instead of
copying, so no description of a state the reader cannot reproduce survives.

### What the concurrency evidence actually proves

Those claims are held up by forced interleavings rather than by ordering two
requests and reading the final state ([#34711](https://github.com/vm0-ai/okou/issues/34711)).
Test-only fixtures suspend or fail exactly one owner's write, and every
rendezvous is an observed arrival — `pg_blocking_pids`, or a committed public
response — never a sleep:

- **Membership cleanup versus refresh.** With the cleanup's `DELETE` held
  uncommitted, the refresher is observed waiting on that exact parent row while
  running its own `for key share` recheck; after the cleanup commits, the
  refresh skips and recreates neither row. In the opposite order the copy is
  held written-but-uncommitted while the cleanup queues behind that
  transaction, and the committed copy then leaves with the parent's cascade.
- **Toggle versus timezone.** Each ownership order suspends the lock holder at
  its projection write and issues the other request while it is held. The
  timezone request's own preference write commits and is publicly readable,
  which is the arrival evidence available for the preference lock: it uses
  `pg_try_advisory_xact_lock` with a retry delay, so a contender never waits on
  a PostgreSQL lock and never appears in `pg_blocking_pids`. A toggle performs
  no write before taking that lock, so its overlap rests on being issued while
  the holder is proven suspended, plus the reads showing it committed nothing
  until the holder released.
- **A failed copy after a committed choice.** A real Settings mutation is
  observed suspended at its projection write with its legacy choice already
  visible, then released into a real database error. The request still returns
  that choice, later reads keep it, the legacy automation is not replayed, and
  an ordinary later write succeeds once the fault is removed.

The limit is equally explicit: because a copy may answer a read only while it
still equals the legacy state, a fresh copy and a missing one are
indistinguishable through the API. Whether a refresh was `refreshed`, `failed`,
`skipped` or `cleared` is therefore asserted where that outcome exists, in the
projection service suite, not inferred from a response body.

### The deletion fence is a cache lifetime, not erasure authority

The row's lifetime is deliberately evictable:

- A composite foreign key to `org_members_cache(org_id, user_id)` with
  `ON DELETE CASCADE` covers today's membership, user, organization,
  auth-cache invalidation and cache-list refresh deletions. The refresh locks
  and rechecks that exact parent with `FOR KEY SHARE`, so a concurrent cleanup
  either waits for the copy and then cascades it away, or has already removed
  the parent and leaves nothing to write. **The refresh never creates or
  refills that parent.**
- Foreign keys to `agents(id)` and `chat_threads(id)` invalidate the copy when
  the owning Agent or the destination thread is deleted. Neither deletion
  creates a replacement thread or an enabled state; the legacy brief stays
  paused or uninstalled exactly as it does today.
- Native writes also pass the existing transaction-level
  [erasure admission](../turbo/packages/db/src/operations/account-erasure.ts):
  READ COMMITTED, sorted organization and user subject locks taken before any
  business row and held through commit.

The limits are as real as the guarantees. `org_members_cache` is a 60-second
read-through role cache, not a tombstone: a concurrent membership read can
refill it after a cleanup, and this projection's writer cannot prevent that.
[The Clerk erasure bridge is still unregistered](account-erasure-foundation.md),
so admission bounds this writer, not the world. None of this is global deletion
finality, and the presence of a row never authorizes executing a brief.

**Hard gate:** before native state becomes execution authority, this evictable
cache lifetime must be replaced with durable membership and erasure ownership.
Cutover must not inherit a disposable parent.

### What this slice does not do

It consumes no occurrence, claims no schedule, advances no due slot, and adds no
Run, Chat event, email, provider request or user credit operation. S3b owns
occurrence, attempt and lease state and lands with the first real S4 collection
executor; S4 owns source collection; S7 owns the complete preference and
enrollment materialization, the durable ownership above, and the cutover. The
production counts below are automation inventory: they are not a native-row
census, and they do not show that any preference has been migrated.

## Observed production scale

A paginated MaskDB read on 2026-09-16 at 09:50:15–09:50:17 UTC, including
internal accounts, found 167 `daily-delivery` automations — 160 enabled, 7
disabled — across 166 `(org_id, owner_user_id)` pairs and 163 organizations.
One owner holds two installations and both are disabled. Historical automation
contexts identify 143 distinct destination threads for 143 automations; 24
automations have no context. All 167 are reconciliation-current with result
email enabled.

A second paginated read on 2026-09-16 at 12:01:06–12:01:07 UTC, on the same
all-production scope, found 168 `daily-delivery` automations — 161 enabled, 7
disabled — across 167 `(org_id, owner_user_id)` pairs and 164 organizations, all
reconciliation-current with result email enabled.

`morning_brief_enrollments` and `workflow_user_automation_threads` are not
exposed in MaskDB, so pending-enrollment counts and canonical thread bindings
are unverified. Historical context counts are a lower bound on threads, not a
count of those tables. Re-measure through supported application or database
tooling before a cutover depends on these numbers.

Neither read is a count of `morning_brief_installed_preferences`, which starts
empty and needs no historical backfill: it is filled only when a member's own
Settings writer runs while the implementation switch is on.
