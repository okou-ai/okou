# Connector catalog rejection diagnostics

The API validates a candidate publication before preparing its immutable
entries and moving the catalog pointer. A rejected candidate never replaces
the serving generation. Existing connectors keep using it; new catalog changes
are unavailable until a later sync accepts a candidate. Retention is not proof
that the catalog is current.

## Interpreting rejection records

Since the [Release 2 contraction](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md#connector-catalog-release-2-contraction-migration-1334),
rejections are not persisted and there is no rejection cache. Every sync
attempt revalidates the current publication, and each rejected attempt emits
one `Connector catalog candidate rejected` WARN. The cron response is only the
attempt report: `{ outcome: "rejected", failureCode }`. It no longer reports
the serving state; observe the retained generation with masked database
queries against `connector_catalog`, or by a later sync of the serving
publication returning `outcome: "unchanged"`. See
[diagnostics removal](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md#connector-catalog-diagnostics-removed-2026-10-07).

- `failureCode` keeps its existing meaning. `relationshipRule`, when present,
  identifies an explicit semantic validator check, such as
  `auth-code-client-registration`, `undeclared-storage-reference`, or
  `unknown-firewall-binding`.
- Rule identifiers are fixed strings. Raw exception messages, causes, private
  binding names, credentials, object keys and candidate payloads are not added
  to the record. Unclassified exceptions keep the coarse failure code without
  an invented rule.
- `catalogVersion` and `catalogDigest` identify the parsed candidate pointer,
  not the serving generation, which `retainedServingHash` reports. They are
  present whenever a pointer was parsed, including a later catalog download
  failure reported as `source-unavailable`; a pointer download or parse
  failure has no candidate identity, so they are absent.
- `sourceId` identifies the storage authority, bucket and persisted-source
  generation salt. It is not a candidate identifier.
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
needs them; see [PostHog deployment ordering](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md#posthog-cimd-oauth).

After an authorized deployment of this diagnostics change, observe the exact API
artifact over a bounded window and record sync/status acceptance or retained
state plus any fresh rejection signature on #33799. Absence of WARN alone is not
recovery evidence. Do not inject invalid catalogs or force production syncs to
test logging without separate authorization.
