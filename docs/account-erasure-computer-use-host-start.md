# Account erasure: Computer Use host START admission

`POST /api/computer-use/hosts/start` is a Computer Use producer. It can create a
legacy host row or reactivate an installation by updating the active
`(org_id, user_id, installation_id)` row. Both paths therefore share the same B1
account-erasure admission boundary.

## Boundary and response

The route keeps its existing authentication policy: an organization is required,
session and PAT callers remain supported, and the route does not inherit the
stricter `computer-use:write` command capability gate. Existing sandbox-token
handling is unchanged.

For an open account, START performs this sequence in one explicit PostgreSQL
`READ COMMITTED` transaction:

1. set transaction-local `lock_timeout` to `1s`;
2. set transaction-local `statement_timeout` to `5s`;
3. take shared B1 admission locks for the organization and user in canonical
   sorted order;
4. start a fresh statement that checks both subjects for an erasure job;
5. after any lock wait, obtain one fresh application clock and create the new
   host credential;
6. execute either the legacy host `INSERT` or the installation partial-index
   `INSERT ... ON CONFLICT ... DO UPDATE`;
7. check request cancellation after the returned write and again after building
   the result; and
8. commit before considering publication.

A closed user or organization returns the same fixed, non-oracular response:

```json
{
  "error": {
    "message": "Account unavailable",
    "code": "FORBIDDEN"
  }
}
```

The closed path does not mint or return a host token, write a host row, rotate an
existing credential, or publish `computerUseHostsChanged`. Lock timeout,
statement timeout, cancellation, and unrelated PostgreSQL failures are not
translated into that 403.

## Concurrency and cancellation

A closure that owns the exclusive B1 lock first commits its decision before a
waiting START performs its fresh closure lookup, so START returns 403. A START
that owns shared admission first retains it through host result construction and
COMMIT, so closure waits and that admitted write completes. Other users and
organizations remain independent.

Cancellation before COMMIT rolls the transaction back, including cancellation
after PostgreSQL has returned the host write. Once COMMIT has executed, a later
abort can suppress the HTTP response and the best-effort invalidation, but it
cannot roll back the host state. A successful, non-aborted commit schedules at
most one `computerUseHostsChanged` event on the owning user's channel.

## Compatibility and exclusions

The fence does not change the active-installation partial unique index, stable
host identity and `created_at`, token rotation, host field normalization,
permissions, capability normalization, or legacy revoked-row behavior.
Concurrent starts for the same active installation still converge on one host
row and one currently valid credential.

Heartbeat, stop, host directory reads, command claim/completion, authorization,
content reads, billing/history, and release or deployment behavior are separate
boundaries.

The focused PostgreSQL route suite is
`apps/api/src/signals/routes/__tests__/computer-use-host-start-erasure.test.ts`.
It covers both write modes, user and organization closures, closure-first and
writer-first ordering with `pg_blocking_pids`, exact transaction controls and
statement order, restored operation, real row-trigger write faults, fresh clock
after waiting, lock timeout, cancellation before entry/during admission/after a
returned write/after COMMIT, early-exit cleanup, exact erasure-job cleanup,
credential compatibility, and owner-channel publication.
