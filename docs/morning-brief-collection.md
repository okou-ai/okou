# Morning Brief source collection

The `simple-morning-brief` pipeline replaces the Morning Brief Official Workflow
Run with a server-side pipeline. This document owns the first real piece of that
execution: an explicitly invoked, bounded Slack collection and the occurrence,
attempt and lease state it consumes.

[The migration contract](morning-brief-migration-state.md) still owns which
installation a member holds and what it is doing. Nothing here changes that
authority, and nothing here schedules, delivers or generates anything.

## What this slice is

- One registered development / protected-preview API entrypoint that really
  runs **admit → claim → Slack reads → normalize → guarded finalize** inside
  the caller's request, and returns an in-memory source envelope.
- The occurrence, attempt and lease state that entrypoint consumes.
- The local ownership boundary shared by claiming, finalizing and the existing
  membership, user and organization cleanup paths.

## What this slice is not

It starts no Run, sandbox or workflow automation, makes no LLM or OpenRouter
call, records no usage or credit operation, writes no Chat event, email or
outbox row, and never touches `next_run_at` or `last_run_at`. There is no cron,
no recovery poller and no background enqueue: a retry is another explicitly
authorized invocation. Schedule ownership stays with the legacy automation.

## The entrypoint

`POST /api/morning-brief/collection-preview/slack` is registered in the ordinary
API route table, so an operator can really invoke it on a development server or
a protected preview deployment. `isPreviewEndpointAllowed` runs before
authentication, so production answers `404` without doing any auth work, and it
stays `404` even when `simpleMorningBrief` is enabled for the caller. On a
preview deployment the request additionally needs the deployment's
protection-bypass secret. That secret is environment protection, never owner
authentication.

Beyond that gate it is an ordinary authenticated route. The owner is the
authenticated organization and user; the native `slack:read` capability is
required; and the only input is a scheduled anchor. No owner, workspace,
channel, credential or `CRON_SECRET` can be supplied.

Admission resolves, in order: the `simpleMorningBrief` switch for this owner,
the canonical installed-and-enabled Morning Brief, the member's timezone, the
installation's Agent, a fresh exact-member Clerk membership, and the native
Slack binding. Each failure is an explicit non-executing outcome returned before
any claim exists, so none of them reaches Slack:

| Reason                                                  | Meaning                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `feature-disabled`                                      | The collector switch is off for this owner.                                        |
| `brief-absent` / `brief-pending` / `brief-inconsistent` | The canonical state is not an installed, reconciled brief.                         |
| `brief-paused`                                          | The owned schedule is disabled.                                                    |
| `missing-timezone`                                      | The member has no valid timezone.                                                  |
| `missing-agent`                                         | The installation's Agent is gone or not usable by this member.                     |
| `membership-revoked`                                    | The fresh Clerk lookup no longer returns this membership.                          |
| `slack-not-installed` / `slack-not-connected`           | No organization bot installation, or no connected account in that exact workspace. |

A missing delivery thread is valid and is never created here.

## Occurrence, attempt and lease ownership

`morning_brief_collection_occurrences` stores only bounded operational metadata.
Its logical identity is `(org_id, user_id, scheduled_for, collection_kind,
collection_version)`. Admission freezes the window
`[anchor - 24 hours, anchor)`, the timezone, the membership generation, the
installation, schedule and Agent, and the Slack workspace and user.

- **Anchor limits.** An anchor more than one minute ahead of the service clock,
  or more than seven days old, is rejected before anything is claimed.
- **One live claimant.** Claiming inserts on conflict and then serializes behind
  `FOR UPDATE`, so concurrent invocations converge on a single admitted attempt.
  A live lease is never stolen and a completed occurrence is never re-collected.
- **Finite leases and attempts.** A lease lasts 60 seconds; an occurrence allows
  3 attempts and stays claimable for 24 hours after it was first admitted.
- **Frozen binding.** No existing occurrence is reused unless its window,
  timezone, membership generation, installation, schedule, Agent and Slack
  binding are all unchanged. This is checked before the row's status is even
  considered, so a completed, failed or running occurrence admitted under an
  older binding answers `binding-changed` rather than being reused, replaced or
  silently swapped for a replacement slot. A remove and rejoin issues a new
  membership id, so it cannot revive the old occurrence.
- **Bounded retry.** A rate-limited attempt records the provider's own
  `Retry-After`; the next explicit invocation before that instant is refused.
  This request never sleeps, and there is no inline retry loop.
- **Commit-time admission.** Waiting for a database lock can outlast a
  60-second lease, so every lease, retry and lifetime comparison reads the clock
  _after_ the transition's own waits. Claiming and finalizing take erasure
  admission, then the member row, then the occurrence row with `FOR UPDATE`, and
  only then sample the instant they decide against. A request timestamp, a
  transaction-start `now()` or a statement clock read before a row wait is not
  that instant.
- **Guarded completion.** Finalization is one conditional update matching the
  exact occurrence, attempt, lease token, membership generation, running status
  and a lease deadline strictly after that freshly sampled instant. Equality
  with the deadline is already expired. Because the transaction already holds
  the row, the update cannot queue again between the check and the write. A
  stale worker therefore cannot overwrite a newer claimant, and an attempt whose
  lease elapsed while it waited has its bundle discarded rather than accepted.
- **No durable body.** Terminal success is metadata about a collection, never a
  checkpoint of one. A duplicate invocation of a completed occurrence makes no
  provider call and answers `already-completed` with an explicit `bundle: null`.
  Retries can observe source edits and deletions; provider reads are not
  exactly once.

Network reads happen outside every database transaction.

## Owner lifetime and revocation

The occurrence's durable parent is the member's own `org_members_metadata` row —
the source of truth for member preferences, including the timezone an enabled
brief requires. It is deleted by membership, user and organization cleanup, and
no background reader refills it. This deliberately replaces the evictable
`org_members_cache` lifetime the installed-preference projection uses; that
cache is not execution authority. A second key to `agents` covers the Agent
lifecycle deletion that invalidates the installation.

Claiming and finalizing both take erasure admission first with
`assertErasureSubjectWritable`, held through `COMMIT`, then lock and recheck that
member row with `FOR KEY SHARE`. Neither ever creates the parent.

That lock orders two transactions but does not survive either of them, and the
parent is deleted only at the very end of each cleanup. The durable half of the
boundary is the member row's own `morning_brief_collection_revoked_at` stamp.
Every cleanup path writes it in the **first transaction it commits**, together
with the run-authority revocation and the occurrence delete it already performs:

| Path         | First committed revocation                              |
| ------------ | ------------------------------------------------------- |
| Membership   | `cleanupOrgMemberResources`'s run-authority transaction |
| User         | the `user.deleted` run-cancellation transaction         |
| Organization | the `organization.deleted` run-cancellation transaction |

That transaction takes `FOR UPDATE` on the member rows in scope before stamping
them, which conflicts with the claimant's `FOR KEY SHARE`, so the two can never
decide at the same time. Both orders are therefore closed, and neither depends
on the foreign-key cascade:

- A claim that commits first is seen by the revoking transaction, which deletes
  its occurrence. Cleanup's later member-row removal is the final backstop.
- A cleanup that commits first leaves the stamp, so the claim refuses — even
  when the claim's external membership answer was resolved before revocation,
  even when the stamping transaction found no occurrence to delete, and even
  though the parent row still exists for the rest of the cleanup.

Only the member row's own deletion clears the stamp, so a member who leaves and
rejoins starts from a fresh row and a new membership generation. A cleanup that
fails after that first commit leaves the owner fenced out of collection, which
is the intended fail-closed direction. Other owners are untouched, and a cleanup
that wins before finalization causes the bundle to be discarded and leaves
nothing that could later complete or resurrect.

**Linearization boundary.** Requests already in flight to Slack cannot be
retracted. What revocation guarantees is that no result of such a request is
accepted, persisted or returned after the revoking transaction commits. This is
a local boundary for one owner's collection authority: a result linearized
before cleanup may still be observed by its own caller afterwards, and no
wall-clock guarantee is claimed against arbitrary external revocation.

**Deploy order.** The stamp is migration 1152, an additive nullable column. The
cleanup writers are unconditional and are not behind `simpleMorningBrief`, so
the migration must ship before the API artifact that writes them; an older
artifact simply never reads or writes the column. See
[deployment compatibility](deployment-compatibility.md#morning-brief-collection-revocation-stamp-34860).

This is explicit-invocation authority only. It certifies no autonomous scheduler
recovery. Durable membership and materialization ownership, and global deletion
readiness, remain S7 gates; the Clerk erasure bridge is still unregistered.

## The Slack source contract

Only the organization's native bot installation intersected with the caller's
connected account in that exact workspace is used. There is no fallback to
another workspace, another account or bot-only visibility, and the native Slack
integration is a different permission system from the user-OAuth `slack`
connector — this path executes no OAuth Agent grant.

Discovery enumerates the current user and bot intersection of non-archived
public and private channels. Direct messages and unshared conversations never
appear. Windowed history is read per channel, and a bounded number of thread
roots discovered inside that history are expanded.

### Finite budgets

| Budget                    | Value                                  |
| ------------------------- | -------------------------------------- |
| Enumeration pages         | 3                                      |
| Channels                  | 20                                     |
| History pages per channel | 2                                      |
| Expanded threads          | 10 (one reply page each)               |
| Provider requests         | 40                                     |
| Normalized messages       | 500                                    |
| Projected text            | 128 KiB total, 4 KiB per message       |
| Wall clock                | 30 s, never beyond the attempt's lease |

Every provider read receives a combined cancellation and deadline signal. The
unbounded convenience loops in `slack-client.ts` are not used.

### Window boundary

Slack's `oldest` and `latest` are both exclusive and the request contract has no
`inclusive` flag, so the collector asks for `oldest = window start - 1 µs`. That
reproduces the half-open `[start, end)` window exactly instead of dropping a
message sitting on the boundary. Timestamps are compared as integer
microseconds and are never rounded or reformatted; deduplication across history
and replies keys on the exact `(channel, ts)` pair.

### Outcomes

`complete` and `partial` both produced a bundle. `partial` means a documented
budget, an unusable continuation or a repeated cursor bounded the read, and it
names each limit that applied. `no_shared_channels` is a healthy empty read.
`rate_limited`, `permission_denied` and `provider_failed` are failures and are
deliberately distinct from an empty read: a mid-stream provider problem, a
`has_more` without a usable cursor, a repeated cursor and an exhausted budget
can never become false completeness.

### Coverage limit

Threads are discovered from the roots that windowed history returns, so **a new
reply on a root older than the window is not found**. The declared scope of this
first collector is bounded channels plus those discovered threads — not a
complete Slack workspace or day. Whether the full pipeline needs older-root
reply coverage is a content-policy decision recorded for the S4/S8 gate.

### Data handling

The bundle carries source, version, the pinned window and timezone, coverage and
limits, the channels read, and entries with workspace and channel identity, the
exact Slack timestamp and thread timestamp, author id, projected text and the
existing channel URL. It does not download files, hydrate attachments, carry raw
provider JSON or prompts, or fan out one permalink request per message.

Source bodies, credentials, prompts, raw provider errors and results are kept
out of every durable table and operational log. The envelope exists only in
memory and is returned only to the authenticated preview caller after a
successful authority and lease finalization. S5 consumes this same in-process
contract.
