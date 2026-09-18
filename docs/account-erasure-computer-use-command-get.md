# Computer Use command GET account-erasure fence

## Scope

This contract applies only to:

```text
GET /api/computer-use/commands/:commandId
```

and the timeout-maintenance sweep that this GET already performs before it
projects the requested command. It does not change Computer Use command
creation, claim, completion, screenshot reads, host APIs, authorization APIs,
audit-list reads, schemas, or controller automation.

The route remains authenticated by the existing Computer Use command auth
wrapper:

- a Clerk session or PAT must resolve an organization and
  `computer-use:write`;
- an Agent token must carry `computer-use:write` and a Computer Use host
  binding;
- the bound Agent host remains an additional requested-command filter; and
- user plus organization remain the command and maintenance owner.

There is deliberately no new persisted-Agent or run existence check. This GET
continues to accept the Agent-token shape that it accepted before this fence.

## Canonical B1 admission

The service opens one explicit `READ COMMITTED` transaction and retains it
through timeout maintenance, requested-command projection, complete public
response-object construction, the final cancellation check, and `COMMIT`.
The route's later HTTP JSON byte encoding occurs after this transaction; it
performs no additional database reads or value conversion.

Inside that transaction it performs, in order:

1. `SET LOCAL`-equivalent `set_config` calls for a 1 second lock timeout and a
   5 second statement timeout;
2. canonical shared B1 admission for the exact caller user and organization;
3. one cancellation check;
4. one fresh `nowDate()` sample;
5. the complete existing exact-owner timeout sweep;
6. the existing requested-command plus optional bound-host projection;
7. the existing public response-object construction and value conversion;
8. one final in-transaction cancellation check; and
9. `COMMIT`, followed by the existing outer cancellation check and HTTP JSON
   byte encoding.

The user/organization subject order is passed to canonical
`assertErasureSubjectWritable`; canonical B1 remains responsible for sorting,
deduplicating, isolation validation, shared advisory locking, and closed-job
lookup.

A canonical `account_erasure:subject_closed` result becomes the route's
existing opaque missing-command result. The route therefore returns the same
404 body for a closed caller, a missing id, a foreign owner, and an Agent bound
to another host:

```json
{
  "error": {
    "message": "Computer-use command not found",
    "code": "NOT_FOUND"
  }
}
```

Lock timeout, statement timeout, cancellation, database failures, and all
other errors are not translated to 404. They retain the normal request failure
path.

## Timeout-maintenance semantics

Admission protects the pre-existing maintenance behavior rather than changing
it.

- The sweep remains scoped only by exact `org_id`, exact `user_id`, and
  `status = 'running'`.
- It is not narrowed by requested `commandId`.
- It is not narrowed by an Agent's bound host.
- The requested id may be missing, foreign, or wrong-host and the caller-owned
  sweep still runs in full.
- The running-row read remains `FOR UPDATE SKIP LOCKED`.
- A command locked by a concurrent completion is skipped without blocking;
  another eligible caller-owned command can still time out in the same GET.
- Timeout writes and any completion audit insert remain in the same
  transaction as admission and projection.
- The timeout comparison remains strict (`now > claimedAt + timeout`). Exact
  equality does not expire a command.
- A persisted timeout is used when present. The retained legacy `NULL`
  fallback remains 120,000 ms.
- One clock sampled after B1 admission owns every comparison, `completed_at`,
  `updated_at`, and timeout audit `created_at` in that sweep.

The helper is also used by host claim. This change does not alter that caller
or put B1 admission inside the helper; only the GET transaction adds the
fence.

## Cancellation and commit boundary

Cancellation before the transaction, after admission, during the sweep, after
each timeout update/audit, and after response serialization raises and rolls
back the complete transaction. In particular, an abort after the timeout
update and audit insert but before the final in-transaction check cannot leave
either mutation durable.

The final in-transaction check is the honest boundary available to this HTTP
request. If cancellation arrives only after that check while PostgreSQL is
already committing, the timeout mutation may commit even though the caller no
longer receives a successful response. The outer check prevents a stale
success response; it cannot recall a committed transaction.

## Preserved response contract

No contract or schema changed. The route still exposes:

- `queued`, `running`, `succeeded`, and `failed` statuses;
- exact command kind and payload, including UTF-8 content;
- nullable host id/name for retained rows;
- nullable persisted timeout;
- ISO timestamps and null lifecycle timestamps;
- successful result metadata, including existing offloaded screenshot
  descriptors rather than private screenshot bytes; and
- existing failure error objects.

A deterministic retained nullable-host fixture serializes to 259 UTF-8 bytes.
Normal and missing projections retain a maximum result cardinality of one.

## SQL and index shape

Focused real-PostgreSQL tests capture the exact target transaction at
`COMMIT`. The fixed statement sequences are:

| Path                               | Statements |
| ---------------------------------- | ---------: |
| open command, no timeout write     |          9 |
| missing command, no timeout write  |          9 |
| closed owner                       |          7 |
| one stale auditable write command  |         11 |
| two stale auditable write commands |         13 |

The open/missing fixed sequence is:

1. `BEGIN` at `READ COMMITTED`;
2. lock timeout;
3. statement timeout;
4. B1 isolation probe plus first shared lock;
5. second shared B1 lock;
6. closed-job lookup;
7. complete owner-running `FOR UPDATE SKIP LOCKED` scan;
8. exact command/host projection with `LIMIT 1`; and
9. `COMMIT`.

The closed path omits both Computer Use queries. Each stale auditable write
adds one command `UPDATE ... RETURNING` and one audit insert before projection;
real one-row and two-row controls pin 11 and 13 statements respectively.
Additional timed-out commands add the existing per-command update and, only
for command kinds already covered by audit policy, audit insert. The owner scan
itself is never limited by the requested id.

The queries use existing schema indexes only:

- `idx_computer_use_commands_org_user` supports exact owner maintenance;
- the commands primary key supports exact command updates and requested-id
  projection;
- the hosts primary key supports the existing left join; and
- audit inserts require no read index.

No migration or new index is required. The existing
`idx_computer_use_commands_host_status` continues to serve host claim paths,
which this change does not modify.

## Acceptance evidence

`computer-use-command-get-erasure.test.ts` exercises production route and
service code against real PostgreSQL. Test-only SQL interception is limited to
pausing a selected production statement while preserving the exact query,
bindings, database result, and transaction control.

The focused matrix covers:

1. session, PAT, capability, supported Agent binding, same-org foreign user,
   foreign organization, wrong-host, missing-org, and nullable response
   compatibility;
2. queued/running/succeeded/failed response fields and offloaded screenshot
   metadata;
3. exact user and organization closure opacity, no timeout/audit/external
   effects, closure removal, and durable-state recovery;
4. read-first and closure-first real B1 blocking, same-owner compatible reads,
   unrelated-owner progress, callback early exit, and complete branch joining;
5. after-wait clock selection, strict explicit and legacy-default timeout
   boundaries, full caller sweep for foreign/missing requested ids, multi-host
   ownership, and foreign-owner isolation;
6. real completion-row locking with `SKIP LOCKED`, rollback of timeout plus
   audit on abort, and the post-final-check commit boundary; and
7. real lock-timeout propagation, pre-entry failure/completion/cancellation,
   rejected generic barrier setup, and healthy recovery;
8. pre-aborted B1-holder setup without database startup, cancellation during a
   controlled pending readiness point in a real PostgreSQL transaction, joined
   release, distinct transaction-error preservation, and healthy holder/GET
   recovery; and
9. pinned SQL/control sequences, with creation and host-claim setup serialized
   so an early failure cannot leave a still-running sibling.

## Deployment compatibility

The original R19 runtime is a code-only additive admission fence. It adds no
table, column, index, contract field, feature switch, or controller step. Mixed
versions continue to use the same data and response shape; the fenced version
only refuses command GET maintenance/projection for a canonically closed user
or organization.

The R19-V validation repair changes only tests, fixtures, and this evidence, so
it needs no independent runtime release. The original R19 runtime still follows
the normal release, deployment, and controller publication-verification gates.
