# Connector catalog rejection diagnostics

The API validates a candidate publication before preparing its immutable
entries and moving the catalog pointer. A rejected candidate never replaces
the serving generation. Existing connectors keep using it; new catalog changes
are unavailable until a later sync accepts a candidate. Retention is not proof
that the catalog is current.

## Interpreting rejection records

Since the [Release 2 contraction](deployment-compatibility.md#connector-catalog-release-2-contraction-migration-1334),
rejections are not persisted and there is no rejection cache. Every sync
attempt revalidates the current publication, and each rejected attempt emits
one `Connector catalog candidate rejected` WARN. The cron response reports that
attempt as `outcome: "rejected"` with its `failureCode`, and `state: "stale"`
while an earlier generation keeps serving.

- `failureCode` keeps its existing meaning. `relationshipRule`, when present,
  identifies an explicit semantic validator check, such as
  `auth-code-client-registration`, `undeclared-storage-reference`, or
  `unknown-firewall-binding`.
- Rule identifiers are fixed strings. Raw exception messages, causes, private
  binding names, credentials, object keys and candidate payloads are not added
  to the record. Unclassified exceptions keep the coarse failure code without
  an invented rule.
- `catalogVersion` and `catalogDigest` identify the parsed candidate pointer,
  not the serving generation, which `retainedServingHash` reports. A source or
  pointer failure has no candidate identity, so those fields are absent.
- `sourceId` identifies the storage authority and bucket. It is not a
  candidate identifier.
- `schemaVersion` identifies the sync target generation. Current APIs sync and
  serve only artifact schema version 4.

## Recovered publication mismatch

[Issue #33799](https://github.com/vm0-ai/vm0/issues/33799) records 127
relationship-rejection observations on 2026-09-11, all retaining an active
snapshot. The events did not log the rule or candidate identity, so they do not
establish 127 distinct invalid catalogs or one unchanged candidate.

PostHog's new static public OAuth client required
[API #33490](https://github.com/vm0-ai/vm0/pull/33490).
[The companion catalog](https://github.com/okou-ai/okou-connectors/pull/4302)
reached production first: its descendant's
[publication](https://github.com/okou-ai/okou-connectors/actions/runs/34638489936)
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
