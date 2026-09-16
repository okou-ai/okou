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

## Observed production scale

A paginated MaskDB read on 2026-09-16 at 09:50:15–09:50:17 UTC, including
internal accounts, found 167 `daily-delivery` automations — 160 enabled, 7
disabled — across 166 `(org_id, owner_user_id)` pairs and 163 organizations.
One owner holds two installations and both are disabled. Historical automation
contexts identify 143 distinct destination threads for 143 automations; 24
automations have no context. All 167 are reconciliation-current with result
email enabled.

`morning_brief_enrollments` and `workflow_user_automation_threads` are not
exposed in MaskDB, so pending-enrollment counts and canonical thread bindings
are unverified. Historical context counts are a lower bound on threads, not a
count of those tables. Re-measure through supported application or database
tooling before a cutover depends on these numbers.
