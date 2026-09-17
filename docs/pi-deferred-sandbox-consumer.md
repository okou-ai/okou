# Durable Pi Sandbox consumer

This is the default-off consumer for the typed launch snapshot v4 and inference
contract v1. It does not create API inference Runs or enable `piDeferredSandbox`.
The API producer is tracked separately in #34244. A legacy encrypted full job
must never be substituted for a v4 waiting intent.

## Durable objects and producer interface

`pi-inference-object.service.ts` publishes immutable, SHA-256 addressed envelopes
in `pi_inference_objects`. Every envelope includes its original user, organization,
kind and schema version. The allowed kinds are configuration, context, H1 and
persistent-secret ciphertext. Reads validate the namespace, hash, envelope and
kind-specific schema. A Run read also requires its exact reference edge.

`retainPiInferenceObject` attaches an exact `(runId, kind, hash)` edge in
`agent_run_inference_objects`. The producer must call it in the same admitted
transaction that writes the corresponding inference input or H1 publication.
The public `publishPiSandboxDemand` entrypoint verifies those inputs and attaches
any missing edges while publishing the first durable intent. A repeated identical
publication is idempotent; a stale epoch, different continuation or unready H0
cannot replace the admitted input. `untouched-h0` requires the ready phase,
activation protection and a not-started provider attempt. H1 requires the settled
publication receipt, including manifest generation and last event sequence.

Configuration records capture the original Agent/resource owner, execution plan,
input, connector scope, model/provider/account route and maintenance identity.
Context records capture exact storage IDs and versions, H0, canonical session ID
and frozen Pi resources. Secrets use the existing persistent encrypted envelope;
no Sandbox token or signed URL is prepared for a waiting intent. None of these
objects use the short-lived S3 staging namespace or an in-memory loader.

The existing owning conversation deletion releases exact reference edges only
after inference usage and Sandbox cleanup preflights permit Run deletion. It
then removes unreferenced objects. Owned user/organization cleanup also removes
orphan publications. The normal cleanup task reclaims unreferenced publications
older than 24 hours in bounded batches. Retained objects have no staging TTL.

## Reservation, materialization and publication

`consumeDeferredPiRun$` is the executable consumer entrypoint used by the queue
drain. Legacy and v4 candidates share original enqueue time / Run ID ordering and
the same organization capacity lock. Unsupported Goal queue rows are excluded.
Waiting v4 work has neither a Sandbox lease nor a Runner job. Existing slot prices
and the base-plus-purchased capacity calculation remain authoritative.

A successful reservation advances the common owner epoch and commits a preparing
lease before environment preparation or external I/O begins. The materializer
uses the retained recipe, original Run/input/session/account and `apiStartedAt`,
exact readonly and writeback storage versions, and the existing credential and
storage preparation paths. It does not create another Run or invoke the initial
provider request. It bypasses the old API-first staging preparation.

Publication starts a new transaction. Complete sorted B1 subject locks precede
resource, catalog, organization, thread, Run/session and provider business locks.
Captured ownership and the real private maintenance lease are revalidated at
this commit point. The locked epoch, intent generation, attempt deadline,
capacity lease, catalog and credential admission must still match before a full
Runner job becomes visible. Earlier preparation never authorizes this write.

Preparation attempts last at most two minutes, within the original two-hour
intent budget. Recovery fences an expired unclaimed attempt, removes any job
under the Run lock, and retries with a newer epoch/generation and original queue
position. After three attempts it retains terminal evidence and stops. Actual
queue and cleanup entrypoints recover without relying on notifications. A corrupt
candidate is retained for diagnosis without stopping other cleanup candidates.

Normal consumer failures atomically retain a terminal-effects marker. Bounded
recovery includes terminal Runs with no lease or an already released lease;
it finalizes active input and retries completion effects. A callback failure
keeps a delayed marker until eligible callbacks are delivered. Closure and the
permanent compute-closure disposition suppress ordinary effects without
settling usage or proving physical release.

Intent enqueue, capacity wait, reservation, materialization and durable
publication emit separate content-free records. Existing claim timing records
and the runtime's start / first actual tool event retain the original API clock.
These measurements do not claim a first-provider HTTP improvement.

## Runner and CLI reader contract

New official Runners advertise `X-Pi-Deferred-Sandbox: 1` on poll. Only an actual
HTTP poll response marked with that header creates a v4-capable candidate and
permits the claim header and durable release journal. Old APIs return unmarked
legacy candidates, whose transient claims remain retryable without a release
endpoint. Direct notifications are hints and cannot opt into the v4 protocol.
The existing claim body remains unchanged.
New APIs exclude v4 work for old readers. The new Pi handoff lives in the existing
outer launch-config v2 under `apiFirstTurn.schemaVersion: 2`. Its fence carries
Run ID, owner epoch, intent generation, canonical session and event sequence,
content digests and explicit active-input eligibility. Physical and blank-pool reuse stay off;
thread active input is independent of the reuse key.

The consumer requires the commit-addressed CLI co-built with its API. Deployment
must install this Runner and CLI reader before enabling a producer. Rollback to
an API without this consumer while v4 jobs/leases exist is not supported; first
drain those owned obligations. This is a release floor, not authorization to
release or enable the feature in this implementation.

The actual claim transaction repeats B1 admission and original ownership checks,
then checks the locked job, common epoch, generation, lease and expiry. Only its
winner changes the existing Run to running and deletes the job. Its Sandbox token
contains the claimed epoch/generation. Checkpoints and completion use this fence;
terminal/cancelled completion can reconcile the immutable claim identity without
regaining execution authority.

The claim response contains no inline H1. The CLI reads
`GET /api/runners/jobs/:id/pi-handoff/:offset` with the Run's Sandbox token. Each
response contains at most 1 MiB of continuation bytes, below the deployed Vercel
function response limit. The source is stable and has no signed-URL expiry.
Each request validates current ownership; cancellation fences later chunks. The
CLI bounds the assembled content, checks the history and resource hashes,
canonical session, pending tool IDs and event sequence, then installs the exact
history atomically before entering the existing pending-tool or settled-session
RPC continuation. It never substitutes an initial prompt for H1.

### Executable handoff size contract

Publication, demand admission, materialization, the chunk API and the CLI reader
share one size contract. Session history is bounded by the CLI's own 16 MiB
session ceiling, measured in UTF-8 bytes rather than UTF-16 code units, so a
multibyte history cannot satisfy a string-length check and then overflow the
reader. The serialized `{sessionHistory, resourceSnapshot}` aggregate the chunk
API streams is bounded at 32 MiB, which individually valid objects can otherwise
exceed together while each still fits the per-object envelope.

Both bounds are applied before a continuation can become executable: immutable
object publication rejects an oversized history, demand admission re-checks the
aggregate once both objects are durable, and materialization checks it again
before the job row exists. The same schema validates durable objects when they
are read. No migration is required for that read-side tightening because no
production publisher exists and `piDeferredSandbox` remains off, including for
staff; deploy this reader before #34244 introduces a writer. An unsupported
continuation is rejected or finalized truthfully; already-incurred inference
usage, diagnostic locators and pending tool identity are retained, and history
is never truncated nor the original prompt or provider request replayed. A
producer calling the demand interface observes `false` and an already terminal
Run rather than queued executable work.

## Physical release proof and uncertain claims

Lease timeout, cancellation and completion alone do not free capacity. Claimed,
releasing and unknown leases remain counted. Immutable claimed epoch/generation
survive terminal fencing so late cleanup can identify the original obligation.

The Runner stores obligations under the host-level Pi recovery directory, outside
version directories and deployment garbage collection. Each process identity
holds a lifetime exclusive OS lock before writing a claim. Current Runners scan
stopped process scopes with that same lock; a live older version cannot be
recovered based on identity inequality. This also retries receipts after a
cleanly drained old version exits.

The Runner fsyncs a per-Run claim journal before its HTTP claim and records the
accepted fence before dispatch. It fsyncs the exact Sandbox binding before
activation. This separate journal survives `status.json` replacement. The same
Run cannot claim again while its journal is unresolved. A failed/ambiguous HTTP
response retains its journal, as does an unknown cleanup result.

Verified destruction writes a durable release outbox receipt. The original claim
barrier remains until the API acknowledges that receipt. A `not-started` receipt
for an unclaimed demand atomically fences the Run/job before acknowledgement, so
a delayed server claim cannot subsequently dispatch. A claimed receipt must
match its exact Runner identity and heartbeat generation or claimed fence.

Heartbeat recovery handles an irrevocably finished actor or a previous Runner
process generation. A bound Sandbox additionally requires its captured original managed
execution cgroup to be empty (including launcher children), a complete process scan, no
unresolved workspace identities and absence of its exact Sandbox. Missing or
unreadable evidence remains unknown. Official Runner startup already requires
managed CPU cgroups and rejects nonempty old guest groups. Local unmanaged
Runners cannot supply this recovery proof.

Claim and release scans keep cursors across bounded heartbeat batches and across
an active foreign-process recovery scope. A release batch scans at most 100
entries, makes at most eight sequential HTTP requests and owns at most five
seconds. An inconclusive response, transport failure or timeout advances only
the selection cursor; the receipt and claim barrier remain durable and the same
cycle can service later receipts. A local process restart reconstructs the scan
from the retained directory. Foreign recovery retains its scoped outbox until
both release and claim scan cycles complete, rather than recreating a cursor on
every heartbeat. A corrupt ownership record is retained; it is never interpreted
as release proof.

The release response has one explicit `outcome`. `released` means matched proof
changed capacity. `stale` is a definitive acknowledgement that the proof owns no
capacity here, so the receipt is quarantined and the claim barrier is removed
without changing another owner's capacity. `inconclusive` means the API could
not reconstruct the owner, so an obligation may remain: the Runner retains both
the receipt and the claim barrier for another cycle, and capacity is never freed
without a matched proof. A missing, malformed or unknown outcome fails response
decoding and retains the same responsibility; it cannot be converted to stale.

There is no old-response fallback for this non-GA path. No production publisher
exists and `piDeferredSandbox` remains off, so an old API cannot produce a v4 job
for a new Runner and old Runners remain excluded from v4 jobs. The capable API,
Runner and commit-addressed CLI become one reader floor before #34244 enables a
producer; after activation, existing v4 obligations must drain before rollback
below that floor.

Cleanup identity is independent of a still-live execution binding. A threadless
private maintenance Run is otherwise discoverable only through the live
`pi_memory_phase2_jobs.maintenance_run_id` mapping, which normal checkpoint
settlement, success and failure retire. Cleanup therefore resolves the resource
from the Run's retained, hash- and namespace-verified captured configuration and
still requires that storage to belong to both the Run owner and the captured
cleanup owner. Execution admission is unchanged and continues to validate the
live maintenance lease.

## Migration and verification boundaries

Supported API traffic and previews require successful database migration before promotion (deployment-compatibility.md and the production/preview workflows). New code on a pre-expansion database is not a serving combination. Old API/Runner code remains compatible after expansion: its tables and required columns are unchanged; new tables are empty and claim columns nullable.

The additive migration creates two initially empty object/reference tables and
adds nullable immutable-claim columns to the existing lease table and a nullable
indexed terminal-effects marker to the intent. No existing
Run data is rewritten. Production masked aggregate observations before schema
work were `agent_runs = 283409` at 2026-09-15 09:30:40 UTC and `blobs = 313862` at
09:30:42 UTC. The masked datasource did not expose the newer inference/intent/
lease tables, so their cardinality was unknown, not zero. Migration numbering is
generated from the current Drizzle journal, never reserved against another PR.

Focused verification uses real PostgreSQL persistence, a separate terminated H1
publisher process, actual queue/Runner HTTP handlers, bounded CLI fetch
interception, existing native RPC continuation tests and Runner compile/tests.
These are implementation checks. A real production Sandbox, provider traffic,
usage reconciliation, deployment and the sub-300ms performance target require the
controller's separate acceptance and release process.
