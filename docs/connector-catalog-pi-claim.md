# Atomic Pi / claim / permission-baseline catalog cohort

## Scope and parents

This is atomic core C, not a separately shippable materializer change. Its parent is runtime PR #37769 at `6376d202560a2c6382137823c077edd80c834440`, including P4a #37699 at `f5e5829c9cd6e30e7604d4b9fc00baf5d78674f1`. Account PR #37768 at `2543cdff2b1085a60832c81a19da2813dbcd8ea6` remains independent and is not merged here. C introduces no dependency on an account-only export: its consumed account/storage/source-ID fields exist at the runtime parent. The account request/list/OAuth cohort and its incomplete CI receipt are not C's work or acceptance.

The approved first-head correction supersedes the earlier visible-head-only design. There is no new source ID, activation epoch, global owner registry, advisory lock, adapter, store restoration, policy version 2, legacy optional identity field, table drop, GC, or publisher cutover.

## Read and write authority

Claim/bootstrap use one request-owned immutable capture and a runtime/metadata union pinned to its hash. The shared materializer accepts captured values and explicit capability facts; it never fetches current, loads a full snapshot, or substitutes an absent manifest member. Declared members missing from the scoped rows throw; genuinely unlisted slugs remain absent.

Pi registration owns all newly introduced SQL inside `registerDemand`'s explicit READ COMMITTED transaction. An expected dependency locks current `FOR SHARE` before the existing owner/generation/head locks. Fresh source facts include the real custom definition version, skill version, MCP declaration, permissionBundleRef, workflow visibility, feature facts and active grant/expiry facts. Entries use only the captured hash. Shared capture functions return SQL fragments or validate plain receipts; they receive no Db, transaction, accessor, node, or command handle.

An initially empty caller is not trusted as an empty authority. If the locked source facts discover dependencies, the transaction rolls back through the no-demand/null path. It does not retry or acquire current late. Missing expected current and missing manifest members are hard errors.

The winning current CAS is the first write/lock. Separate post-wait statements discover and lock catalog-dependent Agent generation owners, then discover heads again and invalidate within the same transaction. Losing CAS and failed transactions have no invalidation effects. Restoring an absent additive mirror at the already accepted identical hash is not a serving cutover and retains the existing N3 no-repeat-effects boundary. Changing an existing immutable hash invalidates even when legacy acceptance already contains the candidate digest. Same-owner `@agent` generations can invalidate reuse across variants; unrelated owners are excluded. Missing heads retain dependency facts, not lease/artifact authority, for later cutovers.

Old source shapes cannot serve ready projections or enter worker publication. Both ready head and artifact source/identity are checked. Canonical repair compares the complete identity, not just storage mounts. A mismatch prevents binding the old canonical snapshot without removing the normal miss, new demand, worker and reconstruction paths. Immutable artifacts are not edited in place.

## Baseline and production caller inventory

The stored baseline remains version 1 and retains its policy and authorization envelope. Its catalog identity is exactly `{schemaVersion, hash, capabilityDigest}`. Old/invalid/missing/incompatible baselines follow existing reconstruction; policies are not erased and stored Run decoding does not fail merely because the baseline is old. Runner reconstruction obtains scoped immutable entries in static owning commands with final-position AbortSignals and post-await cancellation checks. It no longer falls back to `loadConnectorRuntimeSnapshot` in this cohort.

Direct production seams inspected: `agent-run-context.signals.ts` bootstrap capture/selection; `thread-claim-run.service.ts` lazy Pi identity and baseline producers; `runners.ts` baseline decoding, compatibility and full refresh; Pi registration, ready lookup, worker and publication; generation/CAS invalidation; and the scoped custom-definition producer. This is not a claim to have read all ~19k claim lines or all historical 39 callers.

Important activation boundary: at this parent and patch, repository search finds no production caller of `preparePiStableContext`; the existing claim producer exposes lazy `buildCacheIdentity`, while launch planning uses `buildPrompt`. C migrates these existing contracts and the durable service/worker consistently. It does not silently activate a previously dormant durable cache or claim production ready reuse.

## English retirement / preservation ledger

| Retired in C | Replacement / retained boundary |
| --- | --- |
| Bootstrap legacy identity, accepted-payload/projection graph and requiredProjectionCount | Request-owned immutable capture plus runtime/metadata union; no projection fallback. Retired the now-unreferenced createAgentCatalogIdentity/createAgentCatalogProjectionRows, CapturedAgentCatalog/CapturedConnectorCatalogIdentity and captured-row fallback factory; their isolated cache-peek wrapper, serial borrowed-Db scope wrapper, capability-digest wrapper and test-scoped activation wrapper are removed, not ignored in Knip. |
| Pi source catalogIdentity digest and catalogSourceId producers | Mandatory new catalog object or authoritatively empty null; generations, prompt/scope/permission digests and validity horizon retained |
| Borrowed-Db recapture SQL helper | Actual admission transaction executes source/entry/storage SQL; pure value assembly and shared stable-skill predicate remain |
| Source-ID-only Pi activation/invalidation | Current-row fence and scoped post-wait owner/head discovery; legacy source ID only identifies historical dependency rows for retirement |
| Legacy runtime-projection reconciliation as Pi activation authority | Reconciliation remains for its own legacy consumers, not immutable Pi activation |
| Storage-only canonical-match predicate | Complete owner/source/storage/persisted identity comparison; mismatch preserves miss/rebuild |
| Old pending/ready format reuse | Strict source validation, discarded worker authority and cold reconstruction; immutable artifact bytes retained |
| Baseline validationAuthority / legacy identity tuple | Version-1 real hash identity plus unchanged policy/authorization envelope |
| Runner fullRefresh legacy snapshot fallback | Scoped immutable reconstruction in owning static commands; actual grants/expiry/revocation rules retained |
| Pi fixture identity literals | Hashes from actual serialized fixture bytes; unsupported versions are negative fixtures, not invented production identities |

The historical 39 calls / 24 files are not a refreshed count. `user-permission-grants.service.ts` still has legacy snapshot paths in its unrelated grants/permission-write cohort. Those paths and every other uninspected peripheral caller remain outside this bounded retirement; do not count them as removed. No ancestor tests are deleted. Native N1 TODO, expected SQL failure, N2–N5, five engines, teardown order and N3 genuine competing sync requests remain.

## Test-source and verification boundaries

- Ordinary real-PG suite: old pending bytes cannot be leased/upgraded; old ready bytes are appended as a separate historical artifact, rejected, then reconstructed into current reusable input. Fixture hashing is checked against the production digest on a current projection. Existing publication/token/generation and cancellation races are retained.
- Native N3: genuine `Promise.all` competing cron requests now also overlap real Pi admission with metadata-only custom facts; terminal old-hash authority must be cleared, or a newly captured winning-hash demand remains pending. Existing rollback, single-winner, wakeup and identical-mirror assertions stay scoped to their original owner; new owner assertions are separate.
- Native N4: real metadata-only permissionBundleRef capture; first-head current/owner/generation statement order; initially empty/unannounced dependencies leave no demand and do not acquire current late; stale canonical caller produces a new-hash miss/demand instead of old binding.
- Pure guard cases cover legacy/corrupt/unsupported catalog schema/capability envelopes and valid null.

PGlite cannot prove PostgreSQL row-lock races. The native overlap/order assertions are not registration-first/CAS-first real-PG lock acceptance. Runtime tests are not locally executed under the current authorization. A static type/lint pass is not business, native, hooks, full CI, Preview, live MCP, production activation, or performance acceptance. Natural new-PR CI must supply its own evidence; first substantive failure stops acceptance. Historical FAIL/UNKNOWN/TODO/LIMIT, acquisition STOPs, n=8/no matched baseline, exhausted production sampling and missing live MCP positive remain unchanged.
