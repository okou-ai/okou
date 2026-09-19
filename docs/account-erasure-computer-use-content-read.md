# Computer Use binary content account-erasure fence

## Scope and retained authority

This boundary applies only to:

```text
GET /api/computer-use/commands/:commandId/screenshot
GET /api/computer-use/commands/:commandId/plugin-content
```

Both routes retain the existing Computer Use command authorization:

- a Clerk session or PAT must resolve an organization and
  `computer-use:write`;
- an Agent token must carry `computer-use:write` and one bound Computer Use
  host;
- the bound Agent host remains an additional command predicate; and
- the exact authenticated user and organization remain the command-content
  owner.

There is no new Agent, Run, thread, host-liveness or command-liveness authority.
A missing organization or capability and an unbound Agent keep their existing
401/403 behavior. A missing command, foreign user/organization, wrong bound
host, non-succeeded command, null result or absent endpoint-specific pointer
keeps the endpoint's existing opaque 404.

This change does not alter command creation, command metadata GET and its
owner-wide timeout maintenance, claim, completion, offload, retention, audit,
host lifecycle, authorization, schemas, indexes or storage policy.

## One transaction through complete content acquisition

Each content service owns one explicit `READ COMMITTED` transaction. Inside
that transaction it performs, in order:

1. a transaction-local 1 second lock timeout;
2. a transaction-local 5 second PostgreSQL statement timeout;
3. canonical sorted shared B1 admission for the exact organization and user;
4. a cancellation check;
5. the existing exact-owner, exact-command and optional bound-host projection;
6. a cancellation check;
7. endpoint-specific content acquisition and complete service-result
   construction;
8. the operation's final in-transaction cancellation check; and
9. `COMMIT`.

The existing outer cancellation check remains after the transaction. HTTP
`Response` construction and byte delivery happen afterward.

A stored screenshot or plugin-content pointer is selected while the canonical
shared subject locks are held. The same locks remain held while the API awaits
`GetObject`, consumes the complete provider body into one `Buffer`, and
constructs the service result. A valid legacy inline screenshot is decoded and
its complete result is likewise constructed before COMMIT. Plugin content
continues to accept only its stored-pointer form.

Committing after pointer selection and downloading afterward would leave a
closure/content gap, so that split is deliberately not used. The command
metadata GET's owner-wide timeout-maintenance sweep is not copied into either
binary route.

Only the canonical `account_erasure:subject_closed` result becomes null and
therefore the endpoint's existing opaque 404. Lock/statement timeout, SQL,
provider request, body, decoding invariant, cancellation and commit failures
propagate through the normal request failure path. A closed denial performs no
command-content projection and no S3 request.

## Provider cancellation and ownership

`downloadS3Buffer` already accepts an operation signal. Both binary readers pass
their real request operation signal to that helper. The helper passes it to the
AWS `GetObject` request and checks it while consuming the async byte stream. The
service awaits the provider request and complete body lifetime; it does not race
a rejection against live work or leave a transaction, request or body detached.

The 5 second PostgreSQL `statement_timeout` applies only while PostgreSQL is
executing a statement. It does **not** bound S3 provider time, body time, total
transaction duration, response delivery or content size. This change adds no
network timeout, retry, byte cap or global S3 policy. Existing stored object
size and completion/offload policy remain the only content-size contracts.

Cancellation before transaction entry starts no protected read. Cancellation
after admission, after projection, during `GetObject`, during body consumption,
or after result construction rolls back before COMMIT when observed by the
owned work. Provider and body failures are awaited and propagate before the
transaction can finish.

The final in-transaction abort check is the last recall boundary available to
this request. If cancellation arrives only after that check while PostgreSQL is
already committing, the acquired bytes and transaction cannot be recalled. The
outer check prevents a later successful HTTP response, but it does not perform
physical object deletion or claim to recall bytes already delivered after a
successful commit.

## Preserved binary responses

Screenshot success still returns:

- the exact stored or retained legacy bytes;
- the retained screenshot MIME type;
- exact `Content-Length`; and
- `Cache-Control: private, no-store`.

Plugin-content success still returns:

- the exact stored bytes;
- the retained plugin MIME type;
- exact `Content-Length`;
- `Cache-Control: private, no-store`; and
- `Content-Disposition: attachment` with the existing removal of double quotes
  from the stored filename.

No MIME normalization, filename tightening, content transformation or maximum
size is introduced.

## SQL and cardinality

An open stored-pointer or legacy-inline read issues eight database statements,
including transaction control:

| Phase                                           | Statements |
| ----------------------------------------------- | ---------: |
| `BEGIN` at `READ COMMITTED`                     |          1 |
| Transaction-local timeout controls              |          2 |
| Organization and user shared B1 locks           |          2 |
| Fresh closure lookup with `LIMIT 1`             |          1 |
| Exact command-content projection with `LIMIT 1` |          1 |
| `COMMIT`                                        |          1 |
| **Total**                                       |      **8** |

A closed subject omits the command projection and commits the opaque denial in
seven statements. The content query selects only command `status` and `result`
under exact `org_id`, `user_id`, command primary key and optional host id. It
adds no join or row lock and returns at most one row. Existing command owner and
primary-key indexes remain unchanged.

The two B1 subjects and one selected command row are fixed database dimensions.
They do not bound S3 latency, body chunks, stored byte size, response delivery
or historical command cardinality. No production query or benchmark supports a
stronger claim.

## Regression boundary

The focused route suite uses real PostgreSQL and the real service/route path.
Public APIs create and verify stored screenshot and plugin content. The external
S3 mock alone controls realistic provider request and async-body success,
failure and cancellation. One narrowly documented fixture creates a valid
legacy inline screenshot because every current public completion offloads that
historical shape before persistence; its bytes are still observed only through
the authenticated HTTP endpoint.

Coverage includes:

- session, PAT, supported Agent, missing organization/capability/binding,
  same-organization foreign user, foreign organization and wrong-host behavior;
- exact stored and legacy bytes, MIME, length, no-store and retained plugin
  filename quoting;
- missing, non-succeeded and null-pointer opacity;
- user and organization open/closed/restored controls with no S3 read or
  publication on denial;
- read-first held `GetObject` and held body versus closure-first ordering,
  actual `pg_blocking_pids`, unrelated-owner progress and compatible same-owner
  reads;
- pre-abort, cancellation during provider request and body read, provider/body
  failure, a reserved body barrier whose preceding `GetObject` fails before
  entry, B1 lock timeout, early callback exit, final-check/COMMIT distinction
  and healthy recovery;
- immediate observation, release/abort and joining of every started reader,
  provider/body barrier and exact closure job; and
- exact open/closed SQL/control sequences and response-size assertions that do
  not claim bounded provider duration or arbitrary content bytes.

The pre-entry regression reserves the real external S3 fake's next body barrier,
admits a public HTTP read against real PostgreSQL, and holds an exact closure
behind that read. The preceding `GetObject` then fails, so the body barrier has
not entered. The test observes the HTTP failure before entry, joins both the
failed read and closure, removes only that closure job, releases the unentered
reservation, and verifies a subsequent public HTTP read returns exact bytes for
both endpoint forms. This demonstrated no production or test-helper lifetime
defect, so the shared helper and runtime remain unchanged.

## Deployment compatibility

This is a code-only additive admission fence. It changes no route, request,
response, pointer, schema, index, storage key, feature switch or client
contract. Mixed API versions read the same persisted results and return the
same binary responses; only the fenced version denies content for a canonically
closed user or organization. Normal release and controller publication gates
remain separate from source merge.
