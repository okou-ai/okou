# Run bootstrap catalog performance

This is a historical implementation record. The current tests use the single
API project and per-case database selection described in
[API testing](./testing/api-testing.md#case-owned-database-selection); the old
project split, pause mechanism, and corruption fixtures below have been retired.

## Scope

Read only the connector entries needed by a Run from the existing immutable catalog. Preserve connector credential, skill/storage mounting, firewall, permission baseline, Pi identity, account, OAuth and claim behavior. Do not create a new cache, locking protocol, schema, migration or invalidation mechanism.

`createConnectorContextGroups` computes the runtime and metadata connector slug union in a fixed `requested$` node. During graph construction, `createConnectorRuntimeSelection(requested$)` in `connector-catalog-entries.service.ts` connects that dependency to the existing immutable entry reader. Computed evaluation obtains its own `db$`. No computed factory runs during evaluation, and no database handle crosses the new factory boundary. Keeping the factory in the entries service avoids a circular production import with its existing pure runtime materializer.

The read captures current catalog hash/header/manifest and the requested entries in one SQL statement. Entries use `(catalog hash, connector slug)` as their key. Publishing B inserts B entries and moves current; it does not modify or delete A entries. Once the Run captures A, its materialization uses A. The obsolete legacy projection-set identifier is not part of this bootstrap read.

The existing immutable reader validates selected manifest entries and applies current executable-capability filtering. For bootstrap, the same SQL statement also captures the existing source/hash/version/capability-scoped compatibility evaluation. A current attestation keeps its stored auth-method filters and rejects corrupt compatibility payloads, just as the old bootstrap did; a missing or stale attestation uses the existing selected-entry capability derivation. Ordinary immutable readers do not acquire this compatibility join. The wrapper preserves the old Run/Pi/permission-baseline identity fields: configured source ID, captured schema/version/hash, and capability digest. It does not query legacy current to manufacture or compare identity. The new startup path never downloads or decompresses the full gzip and has no full-snapshot fallback. Missing immutable authority or a missing manifest entry remains an invariant error. The follow-up [slug-first projection-reader retirement](./connector-catalog-projection-reader-retirement.md) moves named account/runtime-sync/Pi recapture reads to current entries without caller version pinning. Other full-snapshot readers and this bootstrap compatibility join remain separate boundaries.

## Regression coverage

Keep the ordinary bootstrap file's remaining 13 cases. Relocate its rotation case to the existing catalog-generation project, publishing A and B through production cron routes. Pause after the single immutable current-plus-selected-entries read, publish B, and verify first-claim account metadata still comes from captured A while the next claim omits the removed connector. The former identity-before-entry race is eliminated rather than retried or hidden: identity and requested entries no longer come from separate statements. No sleep, timeout increase, retry, new test project or production test hook is added.

Two existing lifecycle compatibility cases also move to this project: publication now changes immutable current through the real cron route, while the centralized compatibility corruption/filter fixtures retain their fault-injection role. All original claim omissions and invalid-input/no-Run assertions remain. CI on immutable HEAD `21978fcf` exposed both behavior regressions; the migrated public-publication cases also fail against that exact implementation and pass after the compatibility capture repair. Those failures are not test-expectation changes or flakes.

The earlier legacy-reader implementation failed a PostgreSQL reproduction that rotated between identity and projection-row reads; that failure remains recorded. It was replaced, not classified as flaky. Read-only computed factory inputs are explicitly permitted by the user decision recorded in `docs/api-ccstate.md`; command/accessor/DB-handle injection remains prohibited. The broader account/OAuth/Pi/claim/schema changes previously consolidated into this branch remain out of scope. All historical review/CI results remain commit-bound. No production activation or measured latency improvement is claimed without separately observed Run measurements.
