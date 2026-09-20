# Standalone Computer Use host-directory account-erasure fence

## Scope and authority

This boundary applies only to `GET /api/computer-use/hosts`. The directory rows
are owned by the authenticated exact user and organization, so those are the two
B1 subjects. A Run, Agent and chat thread are not authority for this data and do
not need to exist. Existing route authentication remains outside the projection:
sessions and PATs need an organization, and Agent tokens still need
`computer-use:write`, current membership and one bound host id.

The route keeps the existing host contract. Sessions and PATs receive every
non-revoked host for the exact `(org_id, user_id)`, including online, stale,
offline and stopped-but-retained installation hosts. Agent tokens project the
same admitted directory and narrow it to their bound host inside that admitted
transaction; an absent, foreign or revoked binding returns an empty list and
never falls back to another host. A token with no binding keeps its existing
generic 403 after the same closure gate, without returning host data.

This does not change authorization-request reads, Apply or creation, legacy
Slack/Teams authorization sources, host start/stop/heartbeat, command lifecycle,
audit/results/screenshots, grants, providers, schema or response fields.

## Transaction and failure boundary

The route-specific command owns one READ COMMITTED transaction in this order:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`;
2. transaction-local `lock_timeout = '1s'` and `statement_timeout = '5s'`;
3. sorted shared B1 admission for the organization and user, with the isolation
   check folded into the first advisory-lock statement;
4. a fresh closure lookup after both locks have been acquired;
5. an explicit application clock read after any admission wait;
6. the complete exact-owner, non-revoked host selection and serialization in
   descending `last_seen_at` order;
7. the Agent bound-host narrowing, or its unbound denial decision; and
8. the operation's final abort check and `COMMIT`.

The shared subject locks remain held through host serialization, Agent filtering
and commit. The transaction takes no host, Run, Agent, thread or request row lock
and performs no lock upgrade, so concurrent directory reads for the same owner remain
compatible. Closure waits behind a read whose transaction reached the protected
projection. A read that starts behind a committed closure observes the new job
in its fresh READ COMMITTED closure statement and returns 403 without host data.
This database boundary does not promise recall of bytes after an HTTP response
has already left the process.

Only `account_erasure:subject_closed` becomes the existing `{ error: { code:
"FORBIDDEN", ... } }` API shape. Abort, advisory-lock timeout, statement timeout,
SQL and commit failures propagate unchanged. They are never converted into an
empty 200, 403 or 404.

## Post-authentication SQL and cardinality

For an open owner, the driver issues eight statements including transaction
control:

| Phase                                  | Statements | Rows returned to the application |
| -------------------------------------- | ---------: | -------------------------------: |
| `BEGIN ISOLATION LEVEL READ COMMITTED` |          1 |                             none |
| Transaction-local timeout controls     |          2 |      scalar command results only |
| Organization and user shared B1 locks  |          2 |    scalar lock/isolation results |
| Fresh closure lookup with `LIMIT 1`    |          1 |                      zero or one |
| Host directory projection              |          1 |  every matching non-revoked host |
| `COMMIT`                               |          1 |                             none |
| **Total**                              |      **8** |    host cardinality is unbounded |

A closed subject omits the host projection and commits the denial outcome, for
seven statements. A failure rolls back and is not reclassified. The two subject
locks are a fixed admission dimension; they do not bound the host dimension.
There is no host `LIMIT`, pagination or truncation.

The host predicate is exactly:

- `computer_use_hosts.org_id = authenticated org`;
- `computer_use_hosts.user_id = authenticated user`;
- `computer_use_hosts.revoked_at IS NULL`; and
- `ORDER BY computer_use_hosts.last_seen_at DESC`.

`idx_computer_use_hosts_org_user (org_id, user_id)` supports the exact-owner
scan. `idx_computer_use_hosts_last_seen (last_seen_at)` is separate, so the
planner may sort the matching owner rows; no claim is made that ordering is free.
The closure lookup uses the `(subject_kind, subject_id)` prefix of the unique
`account_erasure_subject_generation` index and returns at most one row. Its
`LIMIT 1` does not bound historical index candidates across generations.

A rolled-back local PostgreSQL 18.6 plan inserted 50,000 foreign host rows,
analyzed the table, and ran the exact host predicate against the two-host focused
fixture. PostgreSQL selected `idx_computer_use_hosts_org_user`, performed one
index search, scanned and returned two matching rows, removed zero by the
`revoked_at` filter, then quicksorted those two rows by `last_seen_at DESC`; the
plan touched five shared buffers. This is local predicate/index/scanned-versus-
returned evidence, not a benchmark or endpoint-latency claim.

The focused response fixture selected and returned two complete hosts for a
session and serialized to exactly 1,006 UTF-8 JSON bytes. Every item retains
`id`, `hostName`, `displayName`, `appVersion`, `osVersion`,
`supportedCapabilities`, normalized accessibility/screen-recording/automation
permissions, computed `status`, `lastSeenAt` and `createdAt`. An Agent response
may return zero or one of those selected hosts after the existing bound-id
filter, and that narrowing finishes before the admitted transaction's final
abort check and commit. Production host cardinality is deliberately not inferred
from this fixture and requires no production data query for this change.

## Regression boundary

The focused real-PostgreSQL route suite covers session/PAT/Agent authentication,
missing organization/capability/binding, complete online/offline/stale/stopped
payloads and order, foreign user/organization and revoked-host exclusion,
nonexistent/foreign/revoked Agent bindings, both subject closures and
restoration, read-first and closure-first `pg_blocking_pids` edges, unrelated
owner progress, concurrent same-owner GETs, real admission timeout, operation
abort, deliberately early callback exit with both a reader and closure, failure
before barrier entry, and setup rejection. A local operation owner releases the
barrier, aborts owned controllers, joins every started holder/reader/closure and
surfaces every failure that the test did not explicitly inspect and accept.
