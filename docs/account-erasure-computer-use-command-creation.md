# Account erasure: Computer Use command creation (B2b2-R21)

Scope: [#35361](https://github.com/vm0-ai/okou/issues/35361) under
[#33745](https://github.com/vm0-ai/okou/issues/33745).

This slice fences the three existing Computer Use command creation routes:

- `POST /api/computer-use/commands`;
- `POST /api/computer-use/write-commands`; and
- `POST /api/computer-use/plugin-commands`.

All three already share `createComputerUseCommand$`. R21 places canonical
account-erasure admission and the complete existing creation decision inside
that service's one transaction. It does not change Computer Use host START or
any other host lifecycle operation; that is R22/#35362. It adds no schema,
migration, closure ingress, provider or publication call, audit event, host/run
subject, Agent subject, host/run/Agent row lock, release, or production action.

## Authority and retained behavior

The caller's authenticated `userId` and `orgId` are the only B1 subjects. They
are passed together to `assertErasureSubjectWritable`, which sorts and
acquires their shared subject locks and reads the canonical closure projection
after any wait. Host ids, run ids and Agent ids are not erasure subjects for
this creation slice.

Existing route checks still precede the service transaction:

- normal organization authentication and membership;
- plugin feature-switch admission and payload validation; and
- Agent-token capability and bound-host authorization.

After canonical admission, the service preserves the existing complete
owner-wide host query and command selection rules. It reads every non-revoked
host for the exact caller user and organization, ordered by `last_seen_at`
descending, with **no `LIMIT`, cap, page or cursor**. The unchanged eligibility
logic then preserves no-host `404`, offline/ambiguous/unsupported `409`, Agent
bound-host targeting, payload normalization, run attribution, timeout and
queued-command semantics.

A canonical closed user or organization returns the same fixed, non-oracular
response on all three routes:

```text
403 FORBIDDEN
Computer-use command creation is not available
```

This response is selected before the protected host projection. Only the exact
canonical `account_erasure:subject_closed` result is translated. Lock timeout,
statement timeout, SQL failure and abort remain failures and are not presented
as closure.

## Transaction and SQL contract

Every routed creation attempt that reaches the shared service uses one explicit
`READ COMMITTED` transaction. The successful path is exactly:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`;
2. transaction-local `lock_timeout = '1s'`;
3. transaction-local `statement_timeout = '5s'`;
4. isolation check plus the first sorted shared B1 advisory lock
   (organization);
5. the remaining shared B1 advisory lock (user);
6. indexed canonical closure lookup for the two exact subject pairs, returning
   at most one row;
7. the complete exact-owner host selection, with no limit or row lock;
8. one `INSERT ... RETURNING` into `computer_use_commands`; and
9. `COMMIT`.

The host selection, online/capability/bound-host decision, normalized payload,
returned-row public result construction and final operation-signal check all
remain inside the same transaction. A closed path has seven statements:
`BEGIN`, both settings, two subject-lock statements, closure lookup and
`COMMIT`. It performs no host query and no command insert. An open eligibility
exit performs the host query and commits without an insert.

The first clock sample used by creation is taken only after subject admission
has completed. Host liveness and `created_at`/`updated_at` therefore use one
fresh post-wait time. Waiting behind a B1 lock cannot make a host appear online
from a stale pre-wait timestamp.

The transaction takes no lock on host, command, run or Agent rows. B1 shared
admission is compatible with another creator for the same owner, while a
closure takes the conflicting exclusive subject lock. Thus writer-first
ordering lets the admitted creator commit before closure; closure-first ordering
makes the creator wait, start a fresh `READ COMMITTED` projection after the
closure commits, and return the fixed `403`.

## Cancellation and failure boundaries

The operation signal is checked before entry, after B1 admission, after the host
query, on every eligibility result, after `INSERT ... RETURNING`, after public
result construction, and after the transaction resolves.

- An abort observed after the returned insert row but before the final
  in-transaction check throws from the callback and rolls back the insert.
- A real insert error also rolls back the whole transaction and propagates.
- If abort arrives after the final in-transaction check at the COMMIT boundary,
  PostgreSQL may commit the command while the outer check suppresses the 200
  response. This is the explicit committed-row/lost-response boundary; R21 does
  not claim to cancel a dispatched commit.
- A lock wait is bounded by the real one-second local lock timeout. It remains a
  server failure, not the fixed closed response.

Creation itself emits no Computer Use audit event and performs no realtime or
object-storage publication. Audit remains an unchanged completion-side effect.
The successful response remains exactly `{ commandId, status: "queued" }`.

## Evidence

`turbo/apps/api/src/signals/routes/__tests__/computer-use-command-create-erasure.test.ts`
uses the real routes, PostgreSQL and dormant B1 projection. The narrow
`turbo/apps/api/src/signals/services/__tests__/computer-use-command-create-cancellation.service.test.ts`
exception invokes the production command only to mutation-test the pre-`BEGIN`
guard that an already-aborted request cannot reach past authentication. Together
they cover:

- session, PAT and bound Agent credentials, including exact host, payload,
  timeout and run attribution through public read/claim/audit surfaces;
- user and organization closed/restored controls across read, write and plugin
  creation, with the same fixed `403`, no queued command while closed and one
  production-claimable command after restoration;
- unchanged authentication, plugin feature, bound-host, no-host, offline,
  ambiguous and unsupported precedence;
- writer-first and closure-first B1 blocker edges, unrelated-owner progress and
  deliberate early callback exits whose owners observe, release, abort and join
  every operation and remove the exact closure job; after writer-first commits,
  the exact returned command remains publicly readable with its original host,
  payload, status and timeout;
- compatible same-owner creators while one real `INSERT ... RETURNING` result is
  paused;
- a post-admission clock sample across a real lock wait at the 90-second host
  boundary;
- a narrow PostgreSQL trigger fault at the real command insert, rollback, zero
  public/audit/publication residue and recovery;
- operation abort after an executed returned insert row, plus the documented
  post-final-check COMMIT boundary;
- actual admission-wait cancellation, the real one-second lock timeout,
  pre-entry authentication and bound-host exits, plus a valid pre-aborted
  request that enters no creation transaction, queues no command and leaves the
  deterministic gate reusable; the driver observation records zero `BEGIN`
  statements, while one narrow direct invocation of the production command
  covers its pre-transaction guard because authentication necessarily observes
  an already-aborted public request first;
- three owner hosts returned by one uncapped query, with SQL text proving exact
  owner/revocation predicates, ordering, absence of `LIMIT` and absence of row
  locks; and
- exact nine-statement created and seven-statement closed sequences, including
  `1s`/`5s` transaction-local settings and no protected host/command access on
  the closed path.

The deterministic transaction fixture delays only named real driver statements
and preserves their PostgreSQL results and errors. Tests use PostgreSQL blocker
edges and barrier completion rather than sleeps, fake timers, table locks,
internal service mocks or detached races.
