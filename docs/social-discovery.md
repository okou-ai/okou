# Social discovery and service status

`okou social capabilities [platform] --json` runs offline, including without an
Okou token. Existing `platform`, `operations`, and `notes` fields are retained.
`details` lists public operation variants, accepted CLI inputs and their
constraints, and command help. Only implemented CLI inputs are advertised;
upstream bulk, direct-video and unexposed cache fields are not added by discovery.
YouTube `--refresh` bypasses extraction caches; summary-result caching remains
separate. Summary field maps use either `--fields` or `--fields-file`, with the
implemented field-name and serialized-size bounds and extraction guidance.

For collections, `totalLimit` describes the CLI's total result bound and its
default. `requestPageLimit` is the maximum requested per page;
`effectivePageLimit` describes a reviewed smaller source limit where known.
`null` means no numeric bound is established by that metadata, not unlimited
retrieval. `pageSize` identifies source-controlled sizes, while `pagination`
and `maxPages` describe the available continuation. Collections with no
continuation stop after one request. When present, `sourceLimit` describes a
fixed source boundary, such as Instagram search's single batch of at most 12
reels. `--stream` is available on collection
commands. The source may return fewer results than requested, and a source
limitation does not establish that all matching content was retrieved.

## Live status

`okou social status [platform] --json` calls authenticated
`GET /api/social/status?platform=<platform>`. The CLI accepts `x` as an alias for
`twitter`. The route requires an organization, `social:read` for capability
tokens, and the `socialStatus` feature switch, initially enabled for staff.
Status guidance appears in agent instructions only when that switch is enabled.

The endpoint performs one unauthenticated read of the provider's public status
feed. It sends no caller/provider credentials, queries no account-credit
endpoint, does not check or charge Okou credits, and does not retry or persist
results. Network work has a ten-second timeout and a 256 KiB response bound.
The response is marked `private, no-store`.

- `observedAt` is when Okou processed the response or failure.
- `overall.updatedAt` is the feed's generation timestamp when valid.
- `operations` contains only reviewed public platform/operation variants with
  each entry's own `updatedAt`. Durable downloads use the asynchronous download
  health entry rather than the legacy download entry.
- `healthy`, `degraded`, and `unavailable` map to green, yellow, and red.
  `unknown` means there is insufficient current evidence.
- `overall` combines the reported service-wide health with selected operation
  health. Known unavailable/degraded states take precedence over unknown, and
  unknown takes precedence over healthy. Filtering operations does not remove
  service-wide incidents from the overall result.

Okou accepts observations at most five minutes old and permits up to one minute
of future clock skew. These are application policies, not a provider SLA.
The snapshot and each tool timestamp are checked independently. An unknown
snapshot makes its operation observations unknown too. Reasons identify stale
or invalid timestamps, missing/duplicate tool entries, invalid responses,
network failures, and an unavailable status store. Upstream HTTP 503 means the
status store could not be read; it does not prove all operations are down.
Raw upstream messages and extra fields are not returned.

An unknown diagnostic is a successful status-query result with HTTP 200; auth,
validation and rollout denials retain their normal HTTP error statuses. Public
service health does not prove caller access, quota, balance or request success.

## Contract ownership and rollout

The reviewed public registry is in
[`social-discovery.ts`](../turbo/packages/api-contracts/src/contracts/social-discovery.ts).
Capability input constraints come from implemented request schemas and
collection metadata. New intent variants must update their registry binding
and command-boundary coverage in the same change. The public status contract
is additive; existing CLI request/download routes and response shapes are
unchanged. A new CLI reaching an older API reports its normal error rather
than manufacturing status data. There is no persisted-state migration or
cross-version fallback.

Provider evidence: [OpenAPI](https://api.socialkit.dev/openapi.json) and
[public status](https://api.socialkit.dev/status), reviewed September 14, 2026.
