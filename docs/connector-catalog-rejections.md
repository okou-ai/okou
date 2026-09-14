# Connector catalog rejection diagnostics

The API validates a candidate catalog before atomically activating it. A rejected
candidate never replaces the accepted snapshot. Existing connectors keep using
the accepted catalog; new catalog changes are unavailable until a later sync
accepts a candidate. Retention is not proof that the catalog is current.

## Interpreting rejection records

`Connector catalog candidate rejected` is emitted only after a rejection attempt
commits. A concurrent attempt that loses the revision check retries without
emitting that record.

- A fresh rejection is WARN. A cached rejection without an active snapshot is
  also WARN because no accepted catalog is available.
- A reused cached rejection with an active snapshot is DEBUG. It remains a
  rejected sync, not success; the sync/status API continues reporting stale
  state and `reusedCachedRejection: true`.
  The production Axiom transport drops DEBUG; local output requires the existing
  `OKOU_DEBUG=connector-catalog:sync` setting. No new INFO audit exception is added.
- `failureCode` keeps its existing meaning. `relationshipRule`, when present,
  identifies an explicit semantic validator check, such as
  `auth-code-client-registration`, `undeclared-storage-reference`, or
  `unknown-firewall-binding`.
- Rule identifiers are fixed strings. Raw exception messages, causes, private
  binding names, credentials, object keys, ETags and candidate payloads are not
  added to the record. Unclassified exceptions keep the coarse failure code
  without an invented rule.
- `catalogVersion` and `catalogDigest` identify a parsed candidate pointer, not
  the retained active catalog. A cached 304 observation uses its exact recorded
  rejected candidate. A fresh source/pointer failure does not borrow a previous
  candidate identity. Missing fields mean that identity is unavailable.
- `sourceId` identifies the storage authority, bucket and snapshot generation.
  It is not a candidate identifier: equal source IDs do not establish equal
  catalog versions or contents.

Fine-grained rules are not persisted. Cache-only observations therefore omit
them; the API does not download or revalidate unchanged rejected content just to
enrich a log. Candidate identity/ETag changes and the existing API authority
rules still determine revalidation. A successful sync clears rejected state.
Old and new APIs share the unchanged persisted/public failure-code contract.

## Recovered publication mismatch

[Issue #33799](https://github.com/vm0-ai/vm0/issues/33799) records 127
relationship-rejection observations on 2026-09-11, all retaining an active
snapshot. The events did not log the rule or candidate identity, so they do not
establish 127 distinct invalid catalogs or one unchanged candidate.

PostHog's new static public OAuth client required
[API #33490](https://github.com/vm0-ai/vm0/pull/33490).
[The companion catalog](https://github.com/vm0-ai/vm0-connectors/pull/4302)
reached production first: its descendant's
[publication](https://github.com/vm0-ai/vm0-connectors/actions/runs/34638489936)
completed at 2026-09-11 19:42:13 UTC, shortly before the first WARN at
19:42:48 UTC. The previous API 1.585.1 rejected public auth-code clients.
The last WARN was at 21:48:44 UTC; the API 1.586.0
[promotion job](https://github.com/vm0-ai/vm0/actions/runs/34649350299/job/103432805257)
explicitly recorded an accepted reconciliation at 21:49:06 UTC.

This supports a recovered rollout mismatch, not a continuing catalog outage.
Individual historical events cannot be conclusively attributed without the
missing fields. Deploy compatible API readers before publishing a catalog that
needs them; see [PostHog deployment ordering](deployment-compatibility.md#posthog-cimd-oauth).

After an authorized deployment of this diagnostics change, observe the exact API
artifact over a bounded window and record sync/status acceptance or retained
state plus any fresh rejection signature on #33799. Absence of WARN alone is not
recovery evidence. Do not inject invalid catalogs or force production syncs to
test logging without separate authorization.
