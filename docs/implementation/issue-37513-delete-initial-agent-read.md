# Initial DELETE Agent READ ownership

Related to #37513. H1a moves only the ordinary DELETE route's initial Agent
lookup into a private computed. It does not complete Agent deletion ownership
or close the parent issue.

Implementation baseline: `be95ef18377c7e8823c4965cab734e5b8808c7b1`.
This is a reimplementation against authoritative source in a new isolated
worktree, not restoration of the old staged bytes. Their recoverability remains
unknown.

## Private graph and consumption order

`initialDeleteAgent$` is defined at package scope, before command execution.
It derives the authenticated organization and validated DELETE path from the
existing request nodes, and obtains `get(db$)` locally. No database handle,
accessor, node, signal, or command-owned identity is passed into a factory or
stored in a parameter slot. Construction performs no SQL; first consumption
starts the read.

The command retains this order:

1. Read organization auth, derive the member with the original `member` role
   default, and read validated path parameters.
2. Await the initial lookup at the original SQL consumption checkpoint.
3. Check the caller's AbortSignal before consuming the result.
4. Return the original requested-ID 404 when the row is absent.
5. Evaluate the original pure permission check using owner and visibility.
6. Invoke `deleteAgentById$` with the selected verified Agent ID, unchanged
   organization/member values, and the caller signal as the final argument.
7. Retain the service-result Abort check, business rejection, and 204 response.

Permission evaluation remains outside the computed. Query failures propagate;
no catch, retry, fallback, lock, CAS, timeout, or cancellation compensation is
introduced.

## Query and provider contract

The selection remains exactly `id`, `owner`, and `visibility` from the official
Agent schema, with predicates `orgId = auth.orgId` then `id = params.id`, and
`LIMIT 1`. There is no JOIN, ORDER BY, additional tenant predicate, cast, raw
result assertion, or reduced decoder boundary. Zero rows return `undefined`.
The computed returns the unchanged schema-decoded row, not a permission result.

`db$` and `writeDb$` both use the existing lazy `db()` provider. This change does
not establish a dedicated client, a shared statement snapshot, replica behavior,
or in-flight SQL cancellation. The caller still checks Abort after the await.
A fresh HTTP request Store consumes this lookup once; repeating the command in
the same Store can reuse the cached row or miss rather than observe a fresh row.
No manual cache or invalidation counter is added.

## Scope and verification boundary

Only `agents.ts` and this document change. `agent-deletion.service.ts` is
byte-preserved. Paginated thread-owner reads, transaction cleanup, append writes,
post-commit notifications, Clerk lifecycle, and external I/O remain unchanged.
Transaction delta is zero. H1's thread-owner migration remains a separate design
dependency; this PR is not full Agent deletion or issue closure.

Normal mandatory hooks and commit-message validation are reported at handoff.
No local Vitest, development server, production SQL, race hooks, test weakening,
or deployment is used. Static checks do not prove public acceptance, runtime
query counts, exact scheduling, provider-error versus Abort races, same-Store
repeat freshness, or transaction/notification lifecycle correctness. Independent
review, natural CI, and protected merge are separate steps and authorizations.
