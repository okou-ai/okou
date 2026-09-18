# Account erasure: direct thread Computer Use settings writes (B2b2-R8)

Scope: [#34869](https://github.com/vm0-ai/okou/issues/34869) and its completion
issue [#34903](https://github.com/vm0-ai/okou/issues/34903), under
[#33745](https://github.com/vm0-ai/okou/issues/33745). The implementation merged
as `e7790ae7d506cc3a3d7f33cde78550e8ec5e8f1f` ([#34884](https://github.com/vm0-ai/okou/pull/34884));
this document adds the contract, the completion evidence and the bounded local
cost comparison that the original slice owed, and changes no production code.

The slice fences one endpoint, `POST /api/chat-threads/:id/computer-use-host`,
with the existing dormant [B1 barrier](account-erasure-foundation.md), reusing
the canonical parent lock contract accepted for
[draft and manual title writes](account-erasure-chat-thread-content.md),
[pin writes](account-erasure-chat-thread-pin.md),
[read cursors](account-erasure-chat-thread-read-state.md) and
[model settings](account-erasure-chat-thread-model-settings.md). It installs no
closure decision, ingress, worker, schema, migration or production operation.

A thread's Computer Use binding, its cloud-browser flag and the sidebar event
that mirrors both are account content, not platform billing. This slice stops
the route from producing **new** selection state for a closed subject; bindings
already durable are historical data owned by C2/D/H and are not erased here. It
fences this one writer and no other writer of the same columns.

## What this route actually writes

| Durable effect                                                                        | Where it comes from                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `chat_threads.computer_use_host_id`, optionally `cloud_browser_enabled`, `updated_at` | the route's own `UPDATE`                   |
| One `computer_use_host_updated` sidebar event and its durable sequence id             | `appendChatThreadEvent`                    |
| One content-free `threadListChanged` invalidation                                     | `publishThreadListChanged`, after `COMMIT` |

Nothing else. The route starts no host, stops no host, takes no provider action
and holds no remote call under a lock.

## Canonical identity and admission

The route now calls `withChatThreadContentWrite` and keeps its unchanged route
configuration: `requireOrganization: true` and `missingOrganizationStatus: 401`.
It adds no capability requirement. `authorize` is this route's existing
ownership contract expressed over the real persisted identity:

- `identity.userId === auth.userId`, a non-null Agent and
  `identity.orgId === auth.orgId`.

That matches the predicate the `UPDATE` already used, where the organization
condition is an `EXISTS` over the Agent's `org_id` and `agent_id IS NOT NULL` is
required. The request's own `userId`/`orgId` is a comparison input, never
authority. At most three deduplicated subjects are admitted: the thread user,
the Agent owner when it is a different user, and the actual organization.

`authorize` runs before admission, so an unauthorized request never takes
another account's subject locks.

## Transaction order and retained barriers

Each attempt is one bounded `READ COMMITTED` transaction:

1. `SET LOCAL lock_timeout` (`1s`) and `statement_timeout` (`5s`).
2. Content-free identity resolution, by primary key with a left join on Agents.
3. The route's own ownership check.
4. Sorted shared `assertErasureSubjectWritable` over the distinct subjects.
5. `agents` **FOR KEY SHARE**, then `chat_threads` **FOR KEY SHARE**.
6. Re-read the same content-free identity under those locks and compare.
7. The selection `UPDATE`, then the sequence reservation and the event insert.

The order is **subjects -> Agent -> thread -> content**, and every barrier is
retained through `COMMIT`. The `UPDATE` keeps taking its own
`FOR NO KEY UPDATE`, which does not conflict with the retained `FOR KEY SHARE`,
so no new self-deadlock is introduced and unrelated threads are never
serialized.

## Host eligibility and the retained race

Host eligibility is read **before** the fenced transaction and keeps its own
semantics: a host is eligible when it belongs to the same organization and user
and has `revoked_at IS NULL`. An installed but offline host stays selectable on
purpose.

A host revoked between that read and this `COMMIT` is a **pre-existing** race
that this slice deliberately does not repair. `stopComputerUseHost$` takes the
host `FOR UPDATE` before clearing the threads bound to it, so re-checking the
host under a lock inside this transaction would invert that order. Host-grant
linearization needs its own bounded design; closure fencing neither repairs nor
worsens the existing window.

## Failure contract

| Outcome                                        | Disposition                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Thread missing, foreign, wrong org, null Agent | The existing `404 Chat thread not found`                      |
| Ineligible or revoked host                     | The existing `404 Computer-use host not found`                |
| Host id plus `cloudBrowserEnabled: true`       | The existing `400`                                            |
| B1 subject closure                             | The same existing `404`, with no update, event or sequence    |
| Identity moved under the locks                 | Roll back and reselect, at most three attempts                |
| Attempts exhausted                             | `ChatThreadContentOwnershipChangedError` propagates           |
| Lock wait, statement timeout, abort            | Original database error or cancellation, propagated unchanged |

Closure reuses the existing not-found disposition, so the endpoint stays
non-oracular. Closure is **not** a success `204`, and a timeout, a blocked
parent lock, a cancelled request or any unrelated SQL failure is **never**
reported as a fabricated `404`.

Success and validation semantics are unchanged for an admitted request: binding
a host forces `cloud_browser_enabled` to false, an omitted `cloudBrowserEnabled`
leaves the stored flag untouched, clearing passes `null`, a caller-supplied
`eventId` still makes the append idempotent, and the response is still `204`.

`publishThreadListChanged` runs only after a successful `COMMIT`. A denied,
invalid, cancelled or rolled-back request consumes no sequence id, appends no
event and publishes nothing; the next accepted update takes the very next
sidebar sequence id.

## Evidence already merged

`chat-thread-computer-use-host-erasure.test.ts` holds fourteen real HTTP and
PostgreSQL cases and is not duplicated here: closure denial for the thread user,
a distinct Agent owner and the organization across bind, rebind, clear and both
cloud-browser transitions; invalidation counted for a denied and an accepted
selection; an unrelated owner still selecting while another subject is closed;
a writer-first `COMMIT` barrier observed through `pg_blocking_pids`; owner
transfer and thread deletion under the locks; a late statement failure rolling
back the selection, the event and the sequence together; a held parent lock and
a real request cancellation propagating as failures rather than a closure `404`;
and the unchanged eligibility, authorization, optional-flag and replay contract.

The cancellation case aborts **before** the `UPDATE`. That is the abort
requirement #34869 actually stated, and it is not evidence of post-`UPDATE` or
`COMMIT`-failure coverage.

## Completion evidence

Two acceptance requirements were open when #34884 merged. They are recorded
separately below: the historical deviation is not repaired, re-run or restated
as compliant by anything in this section.

### Historical deviation, unchanged

The implementation owner committed the merged change with
`git commit --no-verify`, reporting a standalone Knip run of approximately 65
seconds against the hook's configured 60-second budget, and API-only type
checking rather than the full configured workspace type hook. That commit
bypassed the normal hooks. Passing CI afterwards does not retroactively make it
a hook-compliant commit, and the verification below is a **new, separate**
observation on the same source, not a repair of that history.

### New verification on the merged source

Current `main` `5392f066c1e75fcbef2812fbe8003d037de1f1ed`, fetched 2026-09-17.
The three R8 blobs are byte-identical at the merge commit and at that `main`:

| Path                                                                  | Blob                                       |
| --------------------------------------------------------------------- | ------------------------------------------ |
| `turbo/apps/api/src/signals/routes/chat-threads-computer-use-host.ts` | `e9123fd84c2cf9d78bb23310480574a2bf266590` |
| `.../routes/__tests__/chat-thread-computer-use-host-erasure.test.ts`  | `f7391adf8d06e248ae77f8a6c97b643e209e4fed` |
| `.../routes/__tests__/helpers/api-bdd-chat-files.ts`                  | `b7306a597b90d9726af0bcc8de1ea9514ff80cb4` |

A docs-only commit skips the TypeScript hook jobs by glob, so it cannot carry
this evidence. The checks were therefore run in a throwaway local verification
worktree whose HEAD reverts only those three paths to `3ca1fc79b5`, the merge's
first parent, leaving exactly the R8 TypeScript surface staged while the
checked-out tree hash stays `9243d049030404695d4d494660468b61a3559b84`, which is
current `main`'s tree. Nothing was published, no merged commit was rewritten and
no empty commit was created.

Runner `lefthook 1.12.3`, the version `docker/toolchain/Dockerfile` installs,
with unmodified configuration: `lefthook.yml` blob
`19f4a0fd190efd8edf1256f6c2492ba9494a4fa4`, `turbo/knip.json` blob
`223d61ce17d4d2fe5bac8ae2dbde704f0eefeaa5`, `turbo/package.json` blob
`1e1548b7ce82ae013482d028105419d75f086f26`. Node v24.21.0, pnpm 10.33.4,
2 vCPU / 3 GB sandbox.

`lefthook run pre-commit`, 2026-09-17T07:54:01.826Z to 07:57:15.602Z,
**exit 0**, lefthook summary 193.74 s, wall 3 m 13.773 s:

| Job                                         | Result                                                                          | Budget |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| `prettier`                                  | 3 staged files, all `(unchanged)`                                               | none   |
| `style-policy`                              | `Style policy passed.`                                                          | none   |
| `platform-static-assets`                    | skipped, no matching staged files                                               | none   |
| `knip`                                      | `Knip found no issues.`                                                         | `60s`  |
| `check-types`                               | `TSC_CHECKERS=2 pnpm check-types`, 14/14 turbo tasks successful in 2 m 24.385 s | `300s` |
| `check-file-size`                           | passed, 0.02 s                                                                  | none   |
| `cargo-fmt`, `cargo-doc`, `uv-lock`, `ruff` | skipped, no matching staged files                                               | none   |

The same runner and configuration, restricted to the single job,
`lefthook run pre-commit --jobs knip`, 07:57:39.958Z to 07:58:24.866Z:
**44.83 s, exit 0**, inside the unchanged 60-second timeout. No glob,
exclusion, budget, `hooksPath` or check was modified, and `--no-verify` was not
used.

One environment limit was real and is reported rather than bypassed: the first
two attempts (07:53:32Z and 07:53:44Z, both exit 1, including one with
`--no-tty`) failed with `open /dev/ptmx: no such file or directory` and skipped
every piped job with `broken pipe`, because the sandbox had no `devpts` mounted.
Mounting `devpts` restored terminal allocation; that is a sandbox repair, not a
change to the repository's hook policy.

## Measured local cost

Local PostgreSQL 18.6 with the repository migrations applied, the API BDD
harness at its real HTTP boundary, one user / organization / Agent / thread and
one installed host, single process, requests issued sequentially. Both builds
share that fixture and differ in exactly one blob: the candidate is current
`main`'s route (`e9123fd8…`), the baseline is the same tree with only
`chat-threads-computer-use-host.ts` reverted to `b854d22d3c7a31de35a4a8f15e84dd79b53717d4`
from `3ca1fc79b5`. Unrelated `main` changes are therefore excluded from the
comparison.

### Round-trip inventory

Statements counted from `log_statement = all`, with marker statements bracketing
one traced request of each shape:

| Request                  | Baseline | Candidate |
| ------------------------ | -------: | --------: |
| Bind a host              |        7 |        17 |
| Enable the cloud browser |        6 |        16 |
| Clear the selection      |        6 |        16 |

Both builds keep the same two preflight reads (thread existence, and host
eligibility only when a host id is supplied), the same `UPDATE`, the same
sequence reservation and the same event insert. The ten added statements per
admitted write are the two `set_config` calls, the identity read, the isolation
probe, two `pg_advisory_xact_lock_shared` calls, the `account_erasure_jobs`
closure lookup, `agents FOR KEY SHARE`, `chat_threads FOR KEY SHARE` and the
revalidating identity re-read. A thread whose Agent belongs to a different owner
adds one further advisory lock, for three subjects.

### Query plans

`EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that had already set the
`1s` and `5s` deadlines, second (warm) execution:

| Added statement              | Plan on the local fixture                                                                       | Rows | Buffers | Execution |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ---: | ------: | --------: |
| Identity read (left join)    | Nested Loop Left Join, `idx_agents_id_org_owner` Index Only Scan over a `chat_threads` Seq Scan |    1 |  3 hits |  0.055 ms |
| B1 closure lookup            | Seq Scan on the empty `account_erasure_jobs`                                                    |    0 |    none |  0.007 ms |
| `agents` FOR KEY SHARE       | LockRows over `idx_agents_id_org_owner`                                                         |    1 |  3 hits |  0.013 ms |
| `chat_threads` FOR KEY SHARE | LockRows over a `chat_threads` Seq Scan                                                         |    1 |  3 hits |  0.009 ms |

The sequential scans are a property of the fixture, not of the statements: the
local `chat_threads` and `agents` tables held three rows each and
`account_erasure_jobs` was empty, so the planner preferred a single heap page.
Re-planned with `enable_seqscan = off`, the same statements use
`chat_threads_pkey` (Index Scan, 2 buffer hits, 0.004 ms) and the
`account_erasure_subject_generation` `(subject_kind, subject_id)` prefix
(BitmapOr of two Bitmap Index Scans, 4 buffer hits, 0.015 ms). Every added
statement resolves at most one row, and none sorts, aggregates or scans a range.
The advisory locks touch no relation at all.

### End-to-end samples

30 sequential requests per sample (10 cycles of bind, cloud-browser enable,
clear), after a discarded warm-up pair, six samples per build across two
processes:

| Build     | Samples (ms)                 | Median | Per request |
| --------- | ---------------------------- | -----: | ----------: |
| Baseline  | 173, 176, 187, 189, 200, 204 | 188 ms |     ~6.3 ms |
| Candidate | 211, 214, 217, 256, 310, 343 | 236 ms |     ~7.9 ms |

The candidate is consistently slower, and in this run its fastest sample still
exceeded the baseline's slowest, so the local direction is not noise. The size
is: the spread inside the candidate build (211–343 ms) is larger than the median
gap, so this bounds the added cost at roughly one to two milliseconds per
request on this machine rather than resolving it precisely. The shape is round
trips, not lock contention — ten more statements on a transaction that must stay
open through `COMMIT` for the barrier to mean anything.

These are bounded local samples on a two-core sandbox with empty erasure tables.
They are not production throughput, not a universal overhead bound and not
evidence that the added cost is irreducible; combining round trips could be
optimised separately without weakening transaction ownership. The parent epic's
dated totals are not this slice's cost.

## Residual work

This is a producer fence for one endpoint only. It erases no existing binding,
cloud-browser flag, sidebar event or snapshot, and it does not complete B2, A2
or account erasure. Explicitly still unfenced, and not covered by this slice:

- `stopComputerUseHost$`, whose `clearComputerUseHostThreadBindings` nulls
  `computer_use_host_id` and appends `computer_use_host_updated` for every
  thread bound to a host.
- The browser-authorization apply path, which sets
  `computer_use_host_id = null` with `cloud_browser_enabled = true`.
- Thread creation and the chat ingress services, which persist a Computer Use
  host id or cloud-browser flag on a new thread, and the test-only runtime
  state routes.
- Every other writer of thread content: the send-path model reconciler, the
  member model preference, image and video model routes, the generated and LLM
  title workflow, message create/send/edit/revoke, run and queue admission, and
  the sidebar snapshot projector.
- Host registration, revocation and provider-side Computer Use data.
- Historical cleanup, inventory and purge of already durable selections.
- Closure ingress, worker activation and any production erasure operation.
