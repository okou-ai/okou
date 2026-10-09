# Home-cache protocol preparation and retirement

This is the additive preparation boundary for [#38135](https://github.com/okou-ai/okou/issues/38135),
PR2 of [#38002](https://github.com/okou-ai/okou/issues/38002). It does not mount or
publish home images, change disk sizing/cwd, migrate workspace images, activate
npm persistence, retire sidecars, deploy a reader floor or run production SQL.

## Independent observations

Heartbeat retains the outgoing `heldWorkspaceStates` envelope and adds
optional/default-empty `heldHomeStates`. Each home state has a reuse key,
canonical completion timestamp and 1–8 `homeCaches` with a profile and
`homeAffinityVersion: 1`. Bounds are 1,024 states and 1,024 caches per snapshot.
Workspace records never populate home state or establish home capability.

Top-level `homeAffinityVersion: 1` advertises protocol support independently of
holding images. A capable empty heartbeat is meaningful. Only official,
authenticated heartbeats establish support; a PAT cannot establish it.

Migration `1357_prepare_home_affinity` adds default-empty `held_home_states`,
nullable `home_affinity_version` and independently observed
`home_affinity_generation` / `home_affinity_sequence`. It preserves outgoing
columns/data and performs no backfill. The prepared API stamps these fields
inside the existing generation/sequence-fenced upsert. A prepared heartbeat
without support clears home capability/state. Replayed/late snapshots cannot
replace accepted observations; identical JSONB retains its stored value.

An outgoing API may advance the shared heartbeat generation/sequence while
leaving the additive columns untouched. Therefore version alone is never
authority: **both observed stamps must equal the current heartbeat stamps**.
Unknown, missing or mismatched stamps mean no home affinity, not no execution.

## Readers, projection and disabled writers

Official poll callers may supply optional `heartbeatGeneration` beside
`runnerId`. Home projection requires their exact current process identity,
group, running/fresh row and current stamped capability. Home holders must also
have current stamps and a matching reuse key/cache profile/admittable profile.
Home and outgoing workspace observations are distinct eligibility paths; a
home reader does not translate workspace holders into home evidence.

The existing ranks/deadlines remain: exact history, finalizing predecessor,
reusable sandbox, then compatible image cache. A preference is advisory, not a
local lease, actual history-byte proof or execution authorization. Old/unknown,
PAT, wrong-process/group/profile and stale readers/holders retain ordinary
execution without a home token.

Claim's execution response has no `runnerPreference`. The existing captured
context projection and strict Pi claim capabilities are unchanged. An echoed
home preference is omitted from telemetry for unsupported claimants; it cannot
turn a queued job into home-only execution.

The real closed Rust preference reader accepts `HomeCache`, independently of
`WorkspaceCache`. Current supervisor heartbeat constructors still leave home
capability absent and observations empty. Current Runner poll writers do not
opt into the new process field. The `home_cache` history-source reader is
prepared, but its producer and completion/result semantics are not activated.

Ably has no recipient capability proof. Its resolver deliberately has no home
reader, so broadcasts remain outgoing-safe even when a unicast poll can return
a home preference. Do not enable a home broadcast writer merely because the
contract compiles or a capable heartbeat exists.

## Supported version and database pairs

Apply the additive migration **before** prepared API promotion. Prepared API
against the pre-expansion database is unsupported; do not add missing-column
fallback SQL. Outgoing API remains valid against expanded schema.

| API source | Runner wire/closed-reader version | Preparation behavior                                                                      |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Outgoing   | Outgoing                          | Existing heartbeat/poll/claim and execution                                               |
| Outgoing   | Prepared                          | Unknown additive heartbeat/poll fields are ignored; no home token                         |
| Prepared   | Outgoing                          | Empty/absent capability; outgoing-safe preference; queued claim still executes            |
| Prepared   | Prepared                          | Current stamped capability permits recipient-safe home projection; empty support is valid |

The unchanged production-route driver
[`runner-home-protocol-compatibility.test.ts`](../turbo/apps/api/src/signals/routes/__tests__/runner-home-protocol-compatibility.test.ts)
is run against actual outgoing API source
`803ede641fb73f38a56c8d799d25bbe14d4def6a` and prepared source. It sends outgoing and
prepared capable-empty envelopes through authenticated heartbeat/poll/claim and
completes the Run normally. Home-specific production-route tests additionally
cover queued old-process claims, replay/reset, bounds, supported projection,
unknown readers, ordering, expiry/freshness and broadcast safety. Rust owner
tests exercise actual manual envelopes and the closed preference reader.
This is protocol/reader evidence, **not four deployed fleets, physical home
image acceptance or an active Runner/Guest cutover**.

The disposable PostgreSQL
[`test-runner-home-affinity-preparation.ts`](../turbo/packages/db/scripts/test-runner-home-affinity-preparation.ts)
uses a frozen outgoing table mapping from
`3dcf096997cdd5448a74df524afba9a2ac46df91`, unchanged in outgoing API
`803ede641fb73f38a56c8d799d25bbe14d4def6a`. It executes real
outgoing/prepared INSERT, UPSERT, SELECT and implicit RETURNING across expansion,
checks preserved workspace data/defaults, and advances outgoing generation and
sequence without updating home columns to verify independent-stamp rejection.
It runs in `test:migration-consistency`; it never targets production.

## Exposure, activation and retirement gates

This is a bounded rollout bridge, not a permanent workspace/home compatibility
layer. Exposure includes independently serving/rollback API revisions, queued
contexts, active/finalizing Runs and artifact-lifetime-bound Guest/Runner images.
Green CI, merge, issue closure or elapsed deployment time do not establish a
reader floor or drain.

- **PR3 / #38137:** establish required Guest helper/image support and coherent
  home cache/mount/format/proof/storage authority before advertising home state
  or enabling home poll/history writers. Preserve captured current inputs and
  verify live bytes; an image hit is not retained-history authority.
- **PR5 / #38139:** retire executing application/generated workspace protocol
  and SQL references after supported serving, queued, active, finalizing and
  rollback readers/writers are accounted for. Audit implicit column projections
  and RETURNING, not just explicit text references. Remove bridge branches and
  their owning tests together; do not retain old-image readers or aliases.
- **PR6 / #38140:** only a separate later release with deployed SQL/rollback
  floor and drain receipts may drop the old physical column. Keep the transition
  validator until its exposure cycle is actually over. Below-floor rollback
  requires reviewed schema restoration or forward recovery, never home→workspace
  reinterpretation.

None of those deployment/activation/retirement receipts is established by this
preparation PR. Parent completion additionally requires runtime/private-byte,
isolation, crash/publication and fleet resource/latency acceptance.
