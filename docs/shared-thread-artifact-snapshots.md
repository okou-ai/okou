# Shared-thread artifact snapshots

With the existing `privateArtifacts` switch enabled for the sharing user and
organization, sharing selected chat messages copies their referenced private
artifacts into an independent resource snapshot. The original messages and
artifact sharing policies are unchanged. The switch remains false by default.

Only the selected messages and their managed static dependencies are included.
User-uploaded input attachments retain the existing independent public snapshot
projection. Existing public links and external resources retain their current
URLs; this feature does not backfill historical data or crawl external websites.

## Snapshot and delivery

- New snapshot tokens contain 10 lowercase alphanumeric characters. Each thread
  share allocates independent aliases; repeated source references within it reuse
  one alias. Conditional registry writes retry collisions and bind new aliases
  to the source resource identity. Aliases are reserved before rewriting links
  and copying bytes, and grant nothing until the parent policy becomes active.
  Failed preparation may leave inert registry tombstones. Existing 24-character
  snapshot tokens remain readable and revocable.
- Files are copied within the private artifact bucket to
  `private-artifacts/<sourceId>/thread-shares/<sharedThreadId>/<token>/<filename>`.
  The copied messages reference `https://a.okou.io/<token>.<extension>`.
- Hosted sites pin one ready private deployment, including its full manifest and
  bundle, under `shared-artifacts/<brand>/<sharedThreadId>/<deploymentId>` in the
  existing hosted-sites bucket. The copied messages reference
  `https://<token>.okou.app/`. Other environments use their configured domains.
- Static managed references in HTML, CSS, JavaScript and JSON are rewritten to
  the same snapshot URLs, including owned private R2 signatures and isolated
  private-site preview URLs. Ownership is checked against the source record;
  possessing an old signature is never publication authority. Relative assets
  stay relative. This does not freeze dynamically constructed URLs or backend
  requests. Unresolvable recognized private dependencies fail the share.
- Repeated references reuse one resource within this share. Later changes to the
  source deployment or file do not update the copied bytes. The planner bounds
  each share to 100 managed resources and 32 MiB of rewritten text, with a 4 MiB
  limit per text asset; existing hosted-bundle limits also apply.

The authoritative R2 policy is
`shared-thread-artifacts/<brand>/<sharedThreadId>.json`. It contains the owner,
original organization, resource targets and `preparing`, `active` or `revoked`
state. The database records the same ownership identity on `shared_threads`.
Aliases use the new `thread-resource` delivery-record kind. The Worker reads the
parent policy before every network request for files, Range, HEAD or site
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
Revoked policies and aliases remain tombstones. Existing snapshots remain
readable and revocable after switch rollback. Revocation denies subsequent
network requests, including Worker content-cache hits. Previously cached browser
copies can remain readable for their one-year lifetime; downloaded bytes and
requests authorized before revocation cannot be recalled.

## Deployment

Apply the additive database migration and deploy the API and host Worker before
enabling a test cohort. Older Workers reject the new delivery-record kind, so
mixed deployments fail closed for new snapshot links. This change creates no
bucket, DNS route, credential or rollout override. Per-PR staging acceptance is
still needed for the deployed App/API/Worker combination.

## Integration messages

Final replies in Slack, Feishu, Lark, Microsoft Teams, Telegram, GitHub comments,
AgentPhone and automation result emails prepare the same resource snapshot before
provider formatting and delivery. The legacy Feishu organization callback follows
the same path. The authenticated message-send APIs for Slack, Feishu, Lark,
Teams, Telegram and AgentPhone also prepare snapshots before sending. This covers
text, nested Slack blocks, Feishu/Lark interactive cards and Teams Adaptive Cards,
including card-only messages and messages with both text and a card. Only outgoing
content is rewritten; recipient and reply/thread identifiers are preserved.
Repeated references within a payload reuse one snapshot resource. Only the outgoing
message's references and their managed static dependencies are selected; canonical
chat history keeps its original private URLs.
Plain text, existing public URLs and external URLs do not create a snapshot.
Authorization/action links and unmanaged download links in the reply retain their
original URLs. Static bundle dependencies retain the stricter sharing checks.

Each delivery has a separate `integration_artifact_deliveries` identity bound to
its owner, organization, brand and source-content hash. It points to a dedicated
`shared_threads` parent for the existing publication and account-erasure protocol.
The parent contains only the rewritten outgoing text values, has no artifact-catalog
entry, and is excluded from public conversation and metadata reads. Manual conversation
shares have independent identities and grants.

Delivery waits for the complete policy to become active. Existing delivery retry
paths reuse its persisted rewritten message and URLs, including after an ambiguous
activation response. Copy failures revoke and clean up the incomplete snapshot;
recognized missing or foreign private references fail delivery. A concurrent
preparation is left alone; a retry can recover a preparing identity older than five
minutes. A delivery record with a revoked policy fails closed. This does not
introduce new provider-message retry behavior.

Proactive sends use the authenticated user and organization as the artifact owner,
so session/PAT callers without a run receive the same checks and replacement.
They do not attach a run or infer ownership from a run ID. Each API call receives
a new delivery identity, including multiple sends within one run. Retrying the
API remains another provider send; this does not add message-send idempotency or
reuse a callback identity across different recipients or content.

Snapshot URLs can be opened by anyone possessing the link. They do not enforce
membership in the destination conversation. Original artifacts retain their
existing privacy and share settings. Account/organization erasure uses the same
foreground revocation and background byte cleanup described above, with the same
browser-cache limitations. Provider messages already sent are not recalled.

Apply migration `1147_integration_artifact_deliveries` before deploying this API.
The Worker must support the existing `thread-resource` protocol before this API
is deployed; this change adds no protocol, App, DNS or bucket requirement. Older
APIs tolerate the additive table; rolling back stops automatic snapshot creation
while existing delivery links retain their policy. Rolling back to an API without
the conversation-read exclusion can expose the outgoing text values if the internal
snapshot UUID is known; no preceding conversation messages are stored in that
parent. The existing `privateArtifacts` switch still controls source artifact
creation; delivery also handles already-created private artifacts after the
switch is disabled.
