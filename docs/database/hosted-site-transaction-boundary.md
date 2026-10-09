# Hosted-site publication and deletion transaction boundary

Local investigation for #37511, based on main
`b2d4bb32f4c1c3915edb2608998711c4b3a68bb1`. This is preparation, not a
completed transaction retirement. The retained remote work and handle forwarding
below remain unresolved under the accepted constraints. They predate #38038.

The subsequent [existing-status reader candidate](./hosted-site-status-reader-candidate.md)
implements an inactive canonical API/Worker ownership check and records a
compatibility matrix and exact visibility/admission and old-deleter boundaries.
Its production gates are not assumed; the separate failed SQL prototype is not
part of this preparation.

## Ownership preparation

The deletion precheck now owns `get(db$)` in
`ownedHostedSiteForDeletion$`. The locked ownership recheck is SQL directly inside
`deleteHostedSite$`'s transaction. Both checks retain the public slug,
organization, creator, and live-site predicates. Historical share lookup in
`revokeHostedSiteShare$` also owns `get(db$)`; revocation still runs before the
site deletion transaction and retains the existing share command.

No schema, pointer, delivery record, policy, public request, or response changes
are part of this preparation. No transaction, lock, compatibility reader,
recovery path, or remote operation has been removed or moved. No new lock,
retry, table, field, or JSON coordination state has been added.

## Decision owners and consumers

| Path                                        | Existing decision and recovery                                                                                                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareHostedSiteDeployment$` / allocation | Reuse the creator's site and allocate its next manifest version under the site row lock. A site deletion retains the site identity and reserved name.                                                                                                                 |
| `completeHostedSiteDeployment$`             | Resolve the owned deployment and chat scope, validate uploaded files, publish its manifest, and then publish pointers. Only uploading/ready deployments may complete.                                                                                                 |
| `publishHostedSiteDeploymentPointers$`      | Publish the deployment's immutable pointer and delivery alias **before** binding the rolling site alias.                                                                                                                                                              |
| `bindHostedSiteDeployment$`                 | Lock the site, recheck deployment deletion and site ownership/layout, preserve version ordering, publish the rolling pointer, and atomically update deployment readiness/site binding.                                                                                |
| `publishHostedSitePointer$`                 | Validate alias ownership; conditionally write the rolling pointer and registry. Validate and adopt an R2 pointer ahead of SQL after an interrupted completion.                                                                                                        |
| `preserveSnapshotToken$`                    | Validate the historical share, source deployment, policy and token alias under the caller's site/share locks. Remove only the named slug from the policy using its ETag. Retain the token and its revocation state.                                                   |
| `deleteHostedSite$`                         | Revoke a historical private share first. Under the same site lock, remove public pointers and owned registry records, mark uploading/ready public/private deployments deleted, and clear the active binding. A failed remote deletion leaves SQL unchanged for retry. |
| Host Worker `serveLegacyHostedSite`         | Resolve the R2 registry/pointer/manifest and serve stored public content. It does not consult SQL deployment status. Its retained unregistered-pointer reader is also relevant until its separate retirement gate.                                                    |

Source owners:
[Host service](../../turbo/apps/api/src/signals/services/host.service.ts),
[pointer publication](../../turbo/apps/api/src/signals/services/hosted-site-publication-migration.service.ts),
[storage gateway](../../turbo/apps/api/src/signals/external/s3.ts), and
[Host Worker](../../turbo/apps/host-worker/src/index.ts).

## Why a SQL-only split is not demonstrated

### An absent pointer carries no deletion identity

Consider the first publication, whose rolling pointer is absent:

1. Completion validates uploading status and reads the absent pointer.
2. Its conditional PUT is delayed before reaching R2.
3. Deletion marks that deployment deleted and deletes its absent pointer and
   registry. The deletion acknowledges success.
4. The delayed `If-None-Match: *` PUT succeeds: the key is still absent.
5. A final SQL status check rejects completion, but cannot retract the public
   bytes atomically or undo a lost response/cancellation before cleanup.

The same absence is observable before first publication and after deletion.
The existing R2 conditional write has no predicate over SQL deployment status.
`deploymentVersion` orders pointers that exist; deletion discards that pointer.
An ETag read before deletion protects replacement of an existing pointer but
does not fence this absent-key case. Rechecking SQL immediately before PUT
leaves the same interval between the check and the remote write.

The current site lock serializes rolling-pointer publication with deletion.
Removing that serialization without a replacement observable at R2 or at every
serving reader introduces this execution. This is a protocol analysis, not a
claim that a SQL-only candidate has passed concurrent testing.

### A delayed delete can remove a new same-address publication

If deletion commits SQL before removing R2 objects, a new prepare can reuse the
same site and publish a higher version at the same rolling key. The old
deletion's later key-only batch removes the new pointer/registry. Reading the
key again before deleting is still a check followed by a separate remote effect.

The repository's `deleteHostedSitesS3Objects` uses `DeleteObjectsCommand` with
only `Key`, without ETag conditions. Cloudflare's
[S3 compatibility documentation](https://developers.cloudflare.com/r2/api/s3/api/)
documents conditional PUT but does not establish conditional DELETE support.
Its [Workers binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
exposes `delete(key)` without conditional options. No production conditional
DELETE experiment was authorized or performed. Even verified conditional
DELETE would not alone solve the absent-key publication case above.

### Existing immutable-pointer failure window

An immutable deployment pointer and its registry are already published outside
the binding transaction. A completion paused there can resume after deletion.
The binding transaction then rejects the deleted deployment and removes those
exact keys. The new delayed-completion case exercises successful cleanup and
checks that a newer same-address redeploy remains active.

That rejection/cleanup is not a durable fence. A storage write that succeeds
remotely but loses its response, or cancellation before binding, can prevent
the cleanup path from running. SQL `deleted` alone cannot stop the Worker from
serving a recreated pointer/registry. This existing window must be considered
alongside the rolling alias before claiming the accepted “deleted versions
never serve again” guarantee for interrupted requests.

A local acceptance probe reproduced the lost-response window through the
production APIs: prepare an upload, pause its immutable-pointer PUT, delete the
site successfully, resume the PUT, then let the registry PUT persist and reject
its response. Completion returned 500; the files API correctly returned 409;
the immutable pointer and delivery registry both remained in R2. The assertion
that the pointer stayed absent failed. The diagnostic source and output were
saved outside the repository; no passing test was substituted for this failed
acceptance condition. Cancellation itself was traced but not separately tested.

## Remaining prerequisites and transaction accounting

An equivalent retirement needs a deletion decision that late public writes and
every supported serving reader can observe at the actual publication/serving
boundary, using an accepted existing protocol. No such decision was found in
the current pointer/registry/manifest contract. A new tombstone, revision,
lease, coordination record, or assumed writer drain is not included as a
workaround.

| Transaction                | Before / after this preparation | Reason it remains                                                                                                                                                 |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site/deployment allocation | 1 / 1                           | Atomic site ownership and version admission; its separate injected DB/helper ownership remains outside this bounded preparation.                                  |
| Binding/publication        | 1 / 1                           | SQL site/deployment atomicity and existing site/share lock ordering. Remote pointer work, deleted-version cleanup, and forwarded Tx remain unresolved.            |
| Site deletion              | 1 / 1                           | SQL public/private deletion and binding reset are one business transition. Remote reads/deletes still serialize with rolling publication under the existing lock. |

The short SQL transactions themselves can remain after a valid publication
boundary is established. Retaining the current remote work is **not** accepted
terminal compliance. The unresolved forwarded handles include
`loadActiveHostedDeploymentVersion`, `publishHostedSitePointer$`,
`retainedPointer`, and `preserveSnapshotToken$`; completion lookup also still
forwards a DB handle. Hiding those handles inside a larger command while leaving
the external publication race would not resolve the prerequisite.

## Local behavior evidence and compatibility limits

[Host deletion tests](../../turbo/apps/api/src/signals/routes/__tests__/host-delete.bdd.test.ts)
construct deployments through authenticated prepare/complete/delete APIs and
observe files/history responses and R2 objects consumed by the Worker. Added
cases cover delayed completion after deletion followed by a new same-address
version, overlapping publication/deletion, and partial remote deletion followed
by a user retry. The storage fixture now honors conditional PUT with
content-derived ETags instead of accepting stale writes unconditionally.

The existing Host suite covers creator-only completion, chat-scoped ownership,
out-of-order completion, immutable version links, and completion retries.
Historical private-site conversion cannot be constructed with the current
public prepare API; its retained code and deployment prerequisites were traced,
not fabricated in a new API fixture.

Archived October 8 evidence at the original base: the seven suites consuming
the updated storage fixture produced 37 passing
cases and 45 failures locally. Running those same suites against unmodified
main produced 34 passing cases and the identical 45 failing case names: 44
Runner claim failures (`Job not found in queue`) and one device authorization
failure. The three added deletion cases passed. This is baseline comparison,
not a claim that the whole consumer suite passed or that the interrupted-request
acceptance probe passed. Refreshed checks are recorded separately in the
exact-HEAD review and handoff rather than substituted for this historical record.

This preparation writes exactly the previous persisted bytes and uses exactly
the previous transaction/lock ordering. Old/new APIs and Workers therefore
share its existing protocol; it introduces no additional rollback floor or
writer-drain requirement. The
[hosted publication compatibility contract](../deployment-compatibility.md#hosted-site-publication-identity)
still prohibits restoring the old HTML snapshot writer after named-alias
conversion. Its Worker/API rollout and historical backfill gates remain
independent requirements.

No evidence of production Host writer drain, conditional DELETE capability,
or a new serving-reader floor was collected. The earlier artifact-share gate
does not establish any of those Host-specific prerequisites. No deployment,
backfill, release, or issue closure is part of this preparation.

## October 9 first ownership batch (#38218)

This continuation starts from main
`bd8b13065d6b8ce406c3c7659f6634528f794913`, the merge of inactive reader
preparation #38212, and is refreshed onto main
`3832d070daf7131ec09c75fe56d2697becf49bf5`. The inventory above describes
the earlier preparation; this section records the subsequent ownership changes. These changes require
no production configuration or reader activation. They do not retire the Host
writer transaction boundary or complete #37511.

Completion, files and history reads now acquire `get(db$)` in stable commands.
Their callers exchange ordinary arguments and results, with the request signal
as the final argument. Completion still resolves the owned deployment and live
site before querying its run scope. A missing external reference remains
unavailable; a malformed binding or dependency failure still propagates. The
private-file reader performs its active-public-version query directly; the
remaining `loadActiveHostedDeploymentVersion` helper is used only by binding
and accepts `Tx`.

`createHostedSiteDeployment$` now acquires `set(writeDb$)` and owns allocation's
transaction. Its public/private maximum-version queries, immutable-asset SQL
and deployment insert run directly in that callback. Manifest and insert-value
construction use ordinary inputs. The asset query retains the required
`executeRawRows(tx, query, rowSchema)` runtime decoder boundary. Prepare still
observes cancellation after the allocation result, preserving atomic commit
and database-error priority, and generates upload capabilities afterwards.

Allocation remains a partial ownership conversion. Its existing run/scope and
slug helpers still receive `Tx`; their query and lock ordering are retained.
The bounded five-candidate slug loop is unchanged. The scope service also has
an operator caller in
[sandbox cleanup state](../../turbo/apps/api/src/signals/routes/test-cron-cleanup-sandboxes-state.ts),
so removing its Host imports would not authorize deleting that service. There
are still three transactions, and no new locks, retries, fallback readers,
schema fields or coordination records.

### Current owners and retained remote work

| Stage                     | Database owner and remaining handle forwarding                                                                                                                                                       | External operations and placement                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create / prepare          | `createHostedSiteDeployment$` owns allocation. `lockHostedRunChatThreadId`, `hasUnscopedHostedSiteConflict`, `findOrCreateHostedSite` and `assertHostedDeploymentScope` retain their Tx call chains. | No external I/O in allocation. Presigned uploads are generated after commit.                                                                                                                                        |
| Complete                  | Lookup commands own their reads; completion owns the existing conditional failed-status update.                                                                                                      | Uploaded-object checks, dependency reads, manifest publication, immutable-pointer PUT and registry registration precede binding, outside its transaction. Artifact recording and preview scheduling follow binding. |
| Bind                      | `bindHostedSiteDeployment$` owns its transaction and still forwards Tx to the active-version read and rolling-pointer publication.                                                                   | Deleted-deployment pointer/registry cleanup and rolling publication remain inside the transaction. The site lock preserves completion-before-delete ordering and version recovery.                                  |
| Migrate / retain snapshot | `retainedPointer` and `preserveSnapshotToken$` use binding's Tx; historical source admission retains its ready-source predicate and share lock.                                                      | Registry, active-pointer, policy and token reads, policy CAS, rolling-pointer CAS and registry CAS remain inside binding. Existing interrupted-publication recovery is retained.                                    |
| Revoke                    | `revokeHostedSiteShare$` owns its lookup; the existing share command owns its SQL work.                                                                                                              | Share policy revocation occurs before the deletion transaction. Copied-token access remains governed by its policy, independently of the source site's SQL status.                                                  |
| Delete                    | `deleteHostedSite$` owns the locked recheck, public/private terminal updates and binding reset.                                                                                                      | Registry ownership reads and key-only pointer/registry deletion remain inside the site transaction. Provider failure rolls back SQL so the existing user retry remains meaningful.                                  |
| Worker / CLI              | Source and configuration are unchanged by this continuation.                                                                                                                                         | The optional SQL reader remains inactive in checked-in deployments. Whole-site deletion still reports the rolling alias plus every completed immutable URL in `offlineUrls`.                                        |

### Verification and remaining minimum scope

Source comparison with the new base confirms that all 17 moved read-query
expressions, allocation version/asset SQL, manifest inputs and deployment
insert values are equivalent. The bodies of binding, manifest publication,
pointer publication, share revocation, registry ownership lookup and deletion
are unchanged. The scope, migration, dependency, share, storage and Worker
sources are unchanged. This is source-level regression evidence, not a
production serving or writer-drain result.

The same eight affected API consumer/authorization suites pass all 86 cases on both
unmodified main and this local continuation, using the same UTC local database
and at most two Vitest workers. Their existing assertions were not changed.
They retain concurrent version allocation, out-of-order completion, successful
overlapping completion/deletion, delayed completion rejection, partial remote
delete followed by retry, and whole-site history/URL behavior. The earlier
45-failure baseline remains historical evidence rather than the baseline for
this continuation.

The failed SQL prototype
`35e14fc5f4afcc08648e64a6b8425138b2ee47e6` remains unchanged and unaccepted.
Its three additional deletion failures are contract failures. In particular,
the current overlapping completion returns 200 before the waiting deletion
takes the whole site offline; changing that completion to 409 is not an
equivalent retirement. The lost-response probe described above also remains
a real unresolved failure: SQL rejects the deleted deployment while its
immutable pointer and registry can survive remotely. Read ownership does not
repair that window.

The smallest uncompleted writer boundary is rolling-pointer/registry
publication and historical policy conversion versus whole-site remote
deletion, together with interrupted immutable publication. Moving those
operations outside the existing serialization is not demonstrated under the
unchanged contract:

- A late PUT to an absent key can recreate a deleted publication. SQL rechecks
  do not make a separate provider write conditional on deployment status, and
  cleanup cannot cover a lost response or cancellation before binding.
- An outgoing key-only deleter can remove a newer publication at the same
  rolling address. Exact-deployment-only cleanup would change whole-site
  deletion and its alias-inclusive `offlineUrls` semantics.
- Reader enforcement alone can deny deleted residues, but does not preserve
  the successful overlapping completion's admission order or prevent an old
  deleter from removing a new live pointer.
- Historical unconditional HTML policy/registry writers and rollback targets
  require their own verified retirement floor. Source SQL status cannot
  replace the retained snapshot token's policy owner. The current prepare API
  cannot construct a historical private source, so that compatibility branch
  remains source-traced rather than fabricated in a new API fixture.

A further retirement therefore needs a demonstrated compatible publication /
deletion protocol or an explicit accepted change to read admission, concurrent
completion and whole-site deletion. Any serving-reader alternative also needs
verified API/Worker/cache/rollback floors, and any mixed-writer alternative
needs evidence about outgoing deleters and historical writers. Previously
issued storage capabilities and admitted responses retain their documented
lifetime. None of these premises is established by merging #38212 or by this
local continuation. The necessary remote behavior and remaining Tx forwarding
are retained; no release, activation, drain, backfill or issue closure is
included.

## Local follow-up candidate after #38218

This candidate starts from main
`8048b6290029e27a1f1fd36a0dd04d24e8e5eb85` and is refreshed onto
`b4c06fde2d6d95b129f63b83661e488e49dd71f2`. Its serial validation is
recorded below. The checks recorded for
#38218 above are separate historical evidence.

Allocation now uses a domain-specific pure query/value plan. It receives
ordinary request values and native query results, and has no database,
transaction, ccstate accessor or executor argument. The existing
`createHostedSiteDeployment$` transaction callback executes every plan step
with the native Drizzle builders. This preserves the run-before-site locks,
the unlocked scoped lookup before an unscoped-conflict check, the locked
lookup before allocation, five slug candidates, per-candidate null-scope run
locks, conflict adoption lookups, both version queries, asset admission,
the final run/site scope admission and deployment insert. These steps remain
one SQL unit with the existing error and cancellation boundary. The raw asset
query still uses `executeRawRows(tx, query, rowSchema)` at its real runtime
executor/decoder boundary.

Binding now owns the active-version, retained-publication, locked share and
ready historical-source queries directly. Remote subcommands exchange site,
share, pointer, policy, bytes and ETag values; they receive no Db or Tx. The
queries and remote actions retain their existing interleaving inside the
same transaction: registry and pointer reads, optional retained-deployment
validation, share lock, policy read/validation, ready-source admission, copied
token validation and policy CAS, then rolling pointer and registry CAS. The
same native site lock still spans promotion, interrupted-publication recovery
and the existing conditional ready/binding updates. Missing active bindings
and invalid retained publications still fail as broken invariants.

The operator-only scope helpers still have their sandbox-cleanup caller and
are retained. Their presence does not make the former Host forwarding a
runtime decoder requirement. There are still three transactions; no lock,
retry, fallback, schema field or coordination record was added.

The remaining writer gap is unchanged: rolling/registry writes, historical
policy conversion and deleted-version cleanup still perform remote I/O in
binding's transaction. Whole-site key-only remote deletion also remains in
its transaction, and interrupted immutable publication can still leave
response-loss residues. Neither the inactive reader nor this handle ownership
candidate establishes a serving, cache, rollback, writer or deleter retirement
floor. The accepted overlapping completion/deletion ordering, alias-inclusive
`offlineUrls`, copied-token authority and partial-delete rollback/user retry
must remain covered by the existing consumer suites.

Lightweight source review confirms that fifteen unchanged commands still have
the same bodies, eight moved value builders retain their bodies, and the
historical policy/share/token guards and policy CAS remain equivalent. Offline
serializer traces of the actual baseline and candidate allocation callbacks
match across eleven ordinary result vectors: ninety statement pairs have the
same sequence, exact SQL text and ordered driver parameters. The moved raw
asset query retains the original literal whitespace. Seven
binding vectors also match twenty-five SQL statements and eleven recorded
remote operations, including delayed older completion, deleted-version
withdrawal and recovery of an acknowledged newer pointer. Eight additional
serializer pairs preserve the share lock, ready historical-source predicate,
retained-publication lookup and active-version query. These witnesses execute
no database or provider operation and do not establish integration acceptance.

The eight affected API consumer/authorization suites pass all 86 cases on
both the exact main baseline and candidate. Each run uses one Vitest process,
at most two workers and an independent local PostgreSQL database with UTC
timezone and all 276 current migrations. The baseline services were restored
from that main revision and the candidate bytes restored exactly afterwards.
Existing tests, assertions and infrastructure selection were not changed.
Affected API/dependency types, full API lint, Knip, formatting and documentation
links also pass.

Supplementary PostgreSQL diagnostics use existing rows produced by those
public API tests. Baseline and candidate allocation queries retain one native
connection/transaction at READ COMMITTED: a competing run update lock waits
while allocation holds its run SHARE lock and waits for the site UPDATE lock.
The repeated run lock and final site admission remain on that owner. A separate
site/share diagnostic confirms the site lock remains held while waiting for
the share UPDATE lock; it uses unrelated existing rows and does not establish
historical private publication admission. Both versions yield identical asset
query rows, text column type, runtime row decoding, invalid-JSON errors and
EXPLAIN plan structure/estimated costs for unchanged, changed and absent
assets. The first draft's ten-space literal indentation difference produces
the same results and plans, and the final candidate restores the exact
original SQL text. Observed execution times are not a performance benchmark.

Historical private-source compatibility remains source-traced where the
current prepare API cannot construct it; synthetic serializer inputs are not
API acceptance evidence. Reader activation, production changes, backfill,
drain, release and issue closure are outside this bounded ownership change.
