# Hosted-site status reader candidate

Local follow-up to [the transaction investigation](./hosted-site-transaction-boundary.md)
for #37511. The current base is main `e42173971274448bcc8afb541cc4b7208bfe80e2`.
This reader preparation is additive and inactive in every checked-in deployment.
It does not establish a production reader floor or authorize transaction removal.

The separate SQL finalization prototype, commit
`35e14fc5f4afcc08648e64a6b8425138b2ee47e6`, remains on its original local branch
with three existing deletion contract failures. It is unaccepted and undelivered;
none of its writer changes or test results are part of this preparation.

## Concrete reader boundary

The canonical API owns `GET /api/host/delivery/:siteId/:deploymentId`. Its stable
command owns `get(db$)` and performs one primary-database deployment/site join
with the deployment primary key, returning only `{ allowed: boolean }`. Its
small projection includes owner identities and a runtime-decoded manifest
identity; it does not load the manifest file list. It requires a public ready
deployment, the site's live identity, matching creator,
organization and persisted layout, the exact R2 prefix/manifest key, and either
the deployment's immutable alias or the site's current active binding. It does
not accept a pointer as authority, fetch a full manifest, or return owner data.
A well-formed missing, deleted, non-ready or incompatible reference yields false.
A database error propagates; conflicting local owner/manifest identities or a
malformed projected identity fail instead of being relabeled missing. The contract
declares the API error boundary's existing generic 500 response; caller-input
validation uses the standard 400 error response. The route requires no credential
because it answers only whether this exact identity is
currently public; it grants no authenticated API, share or download capability.

The Host Worker optionally uses `HOSTED_SITE_API_ORIGIN`. After resolving a
registered or retained unregistered public site pointer, it checks this endpoint
before reading the manifest/file for GET and HEAD, on rolling and immutable
hosts in both layouts. False yields 404. Missing endpoints, storage/database
failure, malformed responses, timeout and cancellation yield 503. Configured
readers never fall back to trusting the pointer. There is no authorization TTL
cache, batching delay, or new persisted coordination state.

Authority fetches use `cache: "no-store"`, refuse redirects, and have a three
second timeout attached to the incoming request signal. Configured public-site
responses use `private, no-store`, including previously immutable assets. The
Cloudflare [request cancellation flag](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/)
is enabled in the local configuration. [Fetch no-store](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
is supported; for non-Cloudflare origins it bypasses Cloudflare's fetch cache,
and authority responses also carry `private, no-store`.

[Workers Cache](https://developers.cloudflare.com/workers/cache/) can answer
without executing the Worker. Its [configuration](https://developers.cloudflare.com/workers/cache/configuration/)
documents that removing `cache` or setting `cache.enabled: false` disables it,
and `private`/`no-store` responses bypass caching. By default a Worker version
has its own cache; `cross_version_cache` can reuse older responses, and rollback
restores the earlier version's cache configuration. The checked-in Wrangler
file has no cache block. Before activation, verify the actual serving versions,
entrypoint configuration and any earlier cached responses cannot bypass the new
check. No live deployment/cache configuration or purge was checked or changed;
checked-in configuration and new response headers do not establish that floor.

## Supported delivery paths and cost

| Entry                                                       | Existing owner and candidate treatment                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site/immutable Host Worker URLs, GET/HEAD, index/SPA/assets | API status/identity check on every configured read, after pointer resolution and before manifest/file delivery. No positive authority cache.                                               |
| Unregistered legacy-pointer reader                          | Goes through the same check; its separate #32492 registration retirement remains required.                                                                                                 |
| Named HTML snapshot publication/token                       | Retains the share policy, token identity and revocation owner. It must not be authorized from a deleted source deployment merely because it is a copied snapshot.                          |
| Thread shared-resource grants and copied files              | Retain their existing grant/policy validation before cached payload delivery. No site-status override.                                                                                     |
| Authenticated host files/history/completion APIs            | Already validate owned deployment status and site binding; the new check is not an alternative to authentication.                                                                          |
| Previously issued object-storage download URLs              | Existing presigned GETs expire after two days and address retained bytes directly. They bypass the Worker. Neither old deletion nor this candidate revokes those capabilities immediately. |

Every configured public request adds one API fetch and one primary-key SQL join,
including every asset. There is no claim of measured production latency or
acceptable capacity. A positive cache or a read replica with deletion lag would
reintroduce a revocation window. The current `db$` uses the same primary
connection owner as `writeDb$`; introducing replicas would change this contract.

Already admitted responses can finish after deletion, as can bytes fetched or
copied earlier. Immediate revocation of all issued presigned URLs or in-progress
reads would require changing the existing capability/retained-byte or read
admission boundary. It is not achieved by a site status join.

## Preserved mutation and scope behavior

The deletion lookup now owns `get(db$)` in a stable command, and the existing
locked lookup is inline in the deletion transaction. Historical-share lookup
also owns its read connection. These ownership changes preserve provider cleanup,
share revocation order, status updates, retry behavior, and response shape.
Completion and deletion still serialize through the existing site row lock;
remote work remains inside the same transaction callbacks. No transaction, lock,
schema field, write ordering or public response is removed or replaced here.

The completion lookup first finds the caller-owned deployment and live site,
then resolves the run's chat scope. Missing/foreign deployment requests do not
sample the run first. This matches the refreshed main; the separate SQL
prototype's scope-order correction is unnecessary for this preparation.

## Activation prerequisites

Merging this additive preparation with the checked-in configuration preserves
current delivery. Setting `HOSTED_SITE_API_ORIGIN` is a separate behavior change:

- All serving API instances and retained API rollback targets must support the
  canonical authority endpoint before the Worker is configured.
- Every intended public site reader, including both layouts and unregistered
  legacy pointers, must invoke the check. Verify CDN/Workers Caching and earlier
  cached responses cannot bypass the Worker; request headers alone are not proof.
- Accept the ready-only admission boundary: today a public pointer may serve
  before SQL commits, whereas the configured reader denies that interval.
  Accept the changed asset cache policy and per-request API/primary-query cost;
  capacity and latency have not been measured in production.

Existing writers remain serialized in this scope, so no writer drain is required
merely to merge inactive preparation. Removing serialization later would still
require its own acceptance, old key-only deleter drain and compatible rollback
floor: reader authorization cannot recreate a newer pointer erased by an older
deleter. Named HTML snapshots retain their independent share/token lifecycle and
historical writer rollback rules. No production reader floor, writer drain,
backfill, cache change or release is established here.

## Compatibility and rollback matrix

| Serving API / Worker / writer                                    | Observable behavior and gate                                                                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old API / old Worker / existing writers                          | Existing pointer-only delivery, remote work under site lock, and the reproduced lost-response resurrection window.                                                      |
| New API / old or unconfigured new Worker / existing writers      | Additive endpoint only. All current writes and delivery behavior remain unchanged. This is the checked-in preparation configuration.                                    |
| Old API / configured new Worker / any writer                     | Authority route is absent: 503, with no pointer-only fallback. Activation before all serving API instances support the route is unsafe.                                 |
| New API / configured new Worker / existing writers               | Deleted residues are denied. R2-before-SQL visibility, cache policy and request cost change as described above; require acceptance and cache/reader-floor verification. |
| New API / old or unconfigured Worker / terminal writer           | Retained rolling aliases and late residual writes can serve deleted bytes. Forbidden deployment/rollback combination.                                                   |
| New API / configured new Worker / mixed old and terminal writers | Old deletion can still erase a newer rolling pointer. Not an equivalent concurrency implementation.                                                                     |
| New API / configured new Worker / drained terminal writers       | SQL status can fence late retained references; old-key-only cleanup cannot remove a newer alias. Other response/admission boundaries above still require proof.         |

After reader activation, an API rollback must retain this endpoint; a Worker
rollback must retain status checks once deletion relies on retained aliases.
Historical HTML snapshot writer and named-alias conversion rollback restrictions
in [deployment compatibility](../deployment-compatibility.md#hosted-site-publication-identity)
remain independent. No historical backfill or reader/writer drain is assumed.

## Local evidence

The API owner tests use real authenticated prepare/complete/delete requests and
the anonymous canonical authorization endpoint. They cover uploading, ready,
foreign identity/layout/path, higher same-address binding, immutable history,
deletion, replacement, and the actual late-write/lost-response execution. The
archived physical-cleanup probe failed its absent-pointer assertion; its
original diagnostic is retained outside the repository. The new test explicitly
observes those residual bytes and checks that the SQL owner denies them.

The Worker tests invoke its real `fetch` entry with R2 and external HTTP
fixtures. They verify GET/HEAD, immutable/rolling aliases, repeated uncached
authorization, authority failure, malformed responses, cache headers,
cancellation and an already admitted read completing. Current verification
belongs to the exact local reviewed HEAD in the handoff,
including refreshed API deletion/authority and Worker suites, contract consumers,
static checks and dry-run bundling. Prior results from the SQL prototype are
separate historical evidence. These owner/consumer checks do not establish live
Cloudflare cache, production request capacity, old writer drain, or a deployment/rollback floor.

Production activation, deployment, writes, backfill and issue closure require
separate authorization. The three existing transaction callbacks remain unchanged
in this preparation; reader code alone is not terminal #37511 compliance.
