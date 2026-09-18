# Shared-thread artifact snapshots

With the existing `privateArtifacts` switch enabled for the sharing user and
organization, sharing selected chat messages copies their referenced private
artifacts into an independent resource snapshot. The original messages and
artifact sharing policies are unchanged. The switch remains false by default.

Only the selected messages and their managed static dependencies are included.
Private input attachments use the same reference and resolution flow. Public
input attachments retain their existing independent public snapshot projection.
Existing public links and external resources retain their current
URLs; this feature does not backfill historical data or crawl external websites.

## Snapshot and delivery

- New snapshot tokens contain 10 lowercase alphanumeric characters. Each thread
  share allocates independent aliases; repeated source references within it reuse
  one alias. Conditional registry writes retry collisions and bind new aliases
  to the source resource identity. Aliases are reserved before rewriting links
  and copying bytes, and grant nothing until the parent policy becomes active.
  Failed preparation may leave inert registry tombstones. Existing 24-character
  snapshot tokens remain readable and revocable.
- Shared messages and private attachment URLs contain absolute App references,
  such as `https://app.okou.ai/artifacts/<reference>.pdf` or
  `https://app.okou.ai/artifacts/<reference>.html`, using the configured
  `APP_URL` origin. A separate, immutable version-3 reference record binds the
  reference to the parent thread share, brand, resource token and target identity.
  Conditional reference writes retry collisions and cannot reuse an owner
  reference or a reference from another snapshot. Nested hosted preview paths
  and queries receive distinct references to the same copied bundle; their
  fragments stay on the App URL. Existing snapshot references pasted into a
  later conversation remain governed by their original share, with hostless
  references qualified to the App origin.
- Files are copied within the private artifact bucket to
  `private-artifacts/<sourceId>/thread-shares/<sharedThreadId>/<token>/<filename>`.
  The App resolves the reference to a temporary signature for those copied bytes.
- Hosted sites pin one ready private deployment, including its full manifest and
  bundle, under `shared-artifacts/<brand>/<sharedThreadId>/<deploymentId>` in the
  existing hosted-sites bucket. The App resolves the reference to a temporary,
  isolated preview origin for that copied bundle, preserving relative assets.
- Static managed references in HTML, CSS, JavaScript and JSON are rewritten to
  byte-delivery aliases (`https://a.okou.io/<token>.<extension>` and
  `https://<token>.okou.app/`), including owned private R2 signatures and isolated
  private-site preview URLs. Ownership is checked against the source record;
  possessing an old signature is never publication authority. Relative assets
  stay relative. This does not freeze dynamically constructed URLs or backend
  requests. Unresolvable recognized private dependencies fail the share.
  Newly copied dependencies use byte aliases rather than App viewer references
  or temporary signatures. Other environments use their configured delivery
  domains.
- Repeated references reuse one resource within this share. Later changes to the
  source deployment or file do not update the copied bytes. The planner bounds
  each share to 100 managed resources and 32 MiB of rewritten text, with a 4 MiB
  limit per text asset; existing hosted-bundle limits also apply.

The authoritative R2 policy is
`shared-thread-artifacts/<brand>/<sharedThreadId>.json`. It contains the owner,
original organization, resource targets and `preparing`, `active` or `revoked`
state. The database records the same ownership identity on `shared_threads`.
The reference resolver checks this parent policy on every request, including
anonymous requests. Only an active policy with the exact recorded resource
identity can issue a temporary URL. Original file ownership and source sharing
settings neither grant nor revoke access to the independent copy. Typed owner
resolution and sharing management reject snapshot references.

The existing `thread-resource` delivery aliases remain available for previously
shared URLs and static dependencies. Their Worker reads the parent policy
before every network request for files, Range, HEAD or site
subresources, including Worker content-cache hits. Successful snapshot responses
return `Cache-Control: private, max-age=31536000, immutable`, allowing browsers to
reuse their local copies for one year. Browser cache hits do not contact the
Worker or recheck the grant. Error responses remain `private, no-store`; the
Worker's internal content-cache lifetime remains 24 hours. No request-time API
or database call is added to Worker delivery, and image-transform requests remain
blocked to prevent independently cached derivatives.

## Publication and removal

Publication creates a preparing policy and durable database identity, then locks
that identity, rechecks current Clerk membership, copies the complete snapshot,
conditionally activates the R2 policy for the reserved aliases. Public thread reads
also require the active policy. All started copies settle before cleanup on a
failure or request cancellation; cleanup revokes the policy before removing
copied bytes and the database identity. Failed cleanup retains the identity for
retry. An ambiguous final R2 write may already have activated the complete
snapshot; callers must reload or revoke that identity rather than assume the
write was rolled back. Incomplete copies are never activated.

Owner-authenticated `DELETE /api/shared-threads/:id` revokes the parent before
deleting snapshot bytes and the shared-thread catalog entry. User and organization
deletion webhooks revoke in the foreground before acknowledging success; storage
failures return a retryable error. Background cleanup removes copied bytes.
Revoked policies, references and aliases remain tombstones. Existing snapshots
remain readable and revocable after switch rollback. Revocation immediately
prevents the reference resolver from issuing further temporary URLs and denies
requests to the retained delivery aliases, including Worker content-cache hits.
Already issued signatures and isolated preview grants do not recheck the parent
policy and can remain usable until their existing expiry or snapshot-byte
cleanup. Previously cached browser copies can remain readable for their cache
lifetime; downloaded bytes and requests authorized before revocation cannot be
recalled.

## Deployment

The App and API share the ordinary artifact reference/temporary-resolution
contracts. Deploy the version-3 reference reader before enabling its writer,
and include the shared-thread App renderer for inline files and attachments.
Serving and supported rollback APIs must retain that reader once references
have been emitted. Version-1 and version-2 references, previous snapshot
delivery aliases and public attachments remain readable under their existing
policies. The Worker reuses the existing private snapshot preview grants and
retains byte-delivery alias support. No database migration, bucket, DNS route,
credential or rollout override is introduced by the reference change. Per-PR
staging acceptance is still needed for the deployed App/API/Worker combination.
