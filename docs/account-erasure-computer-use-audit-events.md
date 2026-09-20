# Standalone Computer Use audit-event account-erasure fence

## Scope and authority

This boundary applies only to `GET /api/computer-use/audit-events`. Audit rows
are owned by the authenticated exact user and organization, so those are the two
B1 subjects. Caller-supplied command, host and run ids remain optional filters;
they do not become authority subjects, and none of those referenced entities
needs an additional existence or lifecycle check.

The route keeps its existing organization-required authentication. Clerk
sessions, including sessions established through Clerk OAuth, and PATs retain
their existing membership behavior. Agent and sandbox tokens remain rejected
because this route has neither a required capability nor the accept-any-sandbox
option. In particular, it does not inherit the standalone host directory's
`computer-use:write` or bound-host behavior.

The response keeps the existing default limit of 50 and maximum of 200, nullable
run/host/app/result/error fields, redacted success/failure/plugin payloads and
`createdAt DESC` order. Equal timestamps still have no promised secondary order.
Empty selector strings remain ignored by the route. Malformed nonempty UUID
command/host selectors retain their PostgreSQL failure behavior; a non-UUID run
selector remains a valid text filter that can return an empty page.

This does not change audit writers, command or host lifecycle, authorization
request creation/reads/Apply, grants, providers, Agents, runs, threads, schema,
indexes or response fields.

## Transaction and failure boundary

The route-specific command owns one READ COMMITTED transaction in this order:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`;
2. transaction-local `lock_timeout = '1s'` and `statement_timeout = '5s'`;
3. sorted shared B1 admission for the organization and user, with the isolation
   check folded into the first advisory-lock statement;
4. a fresh closure lookup after both locks have been acquired;
5. the complete exact-owner, optionally filtered, ordered and limited audit
   projection;
6. serialization of every selected field and redacted JSON value;
7. the operation's final abort check; and
8. `COMMIT`.

The shared subject locks remain held through selection, serialization and commit.
The transaction takes no audit, command, host, run, Agent or thread row lock and
performs no lock upgrade. Concurrent reads for the same owner therefore remain
compatible. Closure waits behind a read whose transaction reached the protected
projection. A read that starts behind a committed closure observes the new job
in its fresh READ COMMITTED closure statement and returns 403 without audit
content. This database boundary does not promise recall of bytes after an HTTP
response has already left the process.

Only `account_erasure:subject_closed` becomes the existing generic
`{ error: { code: "FORBIDDEN", ... } }` API shape. Abort, advisory-lock timeout,
statement timeout, selector/SQL/decoding and commit failures propagate unchanged.
They are never converted into closure or an empty 200 response.

## Post-authentication SQL and cardinality

For an open owner, the driver issues eight statements including transaction
control:

| Phase                                  | Statements | Rows returned to the application |
| -------------------------------------- | ---------: | -------------------------------: |
| `BEGIN ISOLATION LEVEL READ COMMITTED` |          1 |                             none |
| Transaction-local timeout controls     |          2 |      scalar command results only |
| Organization and user shared B1 locks  |          2 |    scalar lock/isolation results |
| Fresh closure lookup with `LIMIT 1`    |          1 |                      zero or one |
| Audit-event projection                 |          1 |                 zero through 200 |
| `COMMIT`                               |          1 |                             none |
| **Total**                              |      **8** |            response limit is 200 |

A closed subject omits the audit projection and commits the denial outcome, for
seven statements. Empty and filtered open results retain all eight statements.
A projection or final-signal failure rolls back and is not reclassified. The two
subject locks are a fixed admission dimension; they do not bound audit history
or physical scan work.

The projection always includes these predicates:

- `computer_use_command_audit_events.org_id = authenticated org`; and
- `computer_use_command_audit_events.user_id = authenticated user`.

It conditionally adds exact equality for nonempty `command_id`, `host_id` and
`run_id`, then applies:

```sql
ORDER BY computer_use_command_audit_events.created_at DESC
LIMIT $requested_limit
```

The selected fields remain `id`, `command_id`, `org_id`, `user_id`, `run_id`,
`host_id`, `kind`, `app`, `event`, `approval_outcome`, `redacted_result`, `error`
and `created_at`; only the established public subset is serialized. Bind order
is the mandatory organization and user, followed by present selectors and the
limit as generated by Drizzle. No selector replaces either owner predicate.

Existing indexes are separate:

- `idx_computer_use_command_audit_command (command_id)`;
- `idx_computer_use_command_audit_org_user (org_id, user_id)`; and
- `idx_computer_use_command_audit_created (created_at)`.

There is no combined owner/order/filter index. A rolled-back local PostgreSQL
18.6 plan inserted 50,000 foreign rows and 250 exact-owner rows, analyzed the
local table, and ran the exact owner predicate with `LIMIT 200`. PostgreSQL used
one `idx_computer_use_command_audit_org_user` index search, scanned and returned
250 owner rows to a quicksort, and returned 200 rows from the Limit; the plan
touched nine shared execution buffers. The fixture rows were absent after
`ROLLBACK`. This demonstrates that an output limit does not prove a 200-row
physical scan bound. It is local predicate/index/scanned-versus-returned evidence,
not a benchmark or endpoint-latency claim.

The focused measured fixture used all three selectors and limit 200. It selected
and returned one complete audit event and serialized to exactly 356 UTF-8 JSON
bytes. Full-payload coverage separately retains success, failure and offloaded
plugin redactions, nullable values and all public fields. Production audit
cardinality is deliberately not inferred from either fixture and no production
data was queried.

## Regression boundary

The focused real-PostgreSQL route suite covers session, Clerk OAuth session and
PAT success; missing auth/organization and existing Agent/sandbox denial; exact
same-org peer and foreign-org isolation; command/host/run selectors and their
combination; empty and malformed selector behavior; nulls, complete redacted
success/failure/plugin projections; default 50, explicit limits, maximum 200,
empty pages and descending order; user and organization closure/restoration; and
absence of command/host mutation or realtime publication.

It also covers read-first and closure-first `pg_blocking_pids` edges, unrelated
owner progress, concurrent same-owner GETs, real admission timeout, operation
abort after the projection, exact SQL/control evidence, deliberately early
callback exit with both a reader and closure, failure before barrier entry, and
setup rejection. A local operation owner releases the barrier, aborts owned
controllers, joins every started holder/reader/closure and surfaces every failure
that the test did not explicitly inspect and accept.
