# Scoped runtime-sync immutable selections

## Scope

The runtime-owned change starts at `348837a965b2004569d066765602648260b090f8` and was first committed as `9c2d0c2cf0b80131519b5c42050d667e2b5dd941` (eight files, +548/-405). It migrates only runtime-sync's builtin runtime and custom permission-metadata selection calls to one existing immutable runtime/metadata union capture. All downstream targets share its hash. Account lifecycle, Pi/claim, full-snapshot/chat-captured cohorts, P5 baseline shapes and final cutover are excluded.

Custom account/configuration/grant facts retain their owned read-only repeatable-read transaction. Readers resolve gateways locally, pass plain facts, use existing caller Store command composition, keep caller AbortSignal last, and await finite work. No new Store/adapter/accessor callback, synthetic catalog identity, process cache mutation or metadata execution capability is introduced. Manifest-outside unknown targets are absent; missing current or a required manifest entry fails closed without legacy/R2 fallback. The surrounding diagnostic full snapshot remains unmigrated.

## Actual stack integration

The initial commit has sole parent 348; observing GitHub's advanced base at 5536 did not incorporate that code. Natural pull-request CI exposed a dangling unused generation import that the initial local scoped test project did not include.

This revision normally merges exactly parent `f5e5829c9cd6e30e7604d4b9fc00baf5d78674f1`, whose sole parent is `5536ce04069b638594451973254a403e47d9606d`. It takes the actual generation isolation/import cleanup and inherited main/1322 migration chain rather than copying fixes or rebuilding metadata. Git reports one automatic merge of the ordinary run-lifecycle file and no conflicts. Existing runtime mixed-sync assertions remain in the ordinary file; parent Automatic publication contracts remain in their unchanged generation file. Parent native bootstrap/membership, runtime N4/N5 additions, N3 competitors and five-engine teardown are retained. This author integration is not independent review of the parent patch or resolution.

## Retirement ledger

| Case or mechanism                                       | Retired mechanism                                                                                                        | Replacement and retained behavior                                                                                                                                                                                                                                                           | Evidence boundary                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing ordinary mixed-sync case                       | Four per-case catalog installs, private bucket switching, active-payload/projection-digest corruption and fallback stage | Shared fixed catalog; real API-created builtin/custom accounts and grants; exact source IDs; runtime/firewall variables; allow/deny and unknown policy; custom-only empty permissions; unknown absent; metadata-only custom result with equal firewall/policy; cleanup and run cancellation | Original local static results are historical; no local business execution. New natural CI is separate.                                            |
| `corruptApiTestConnectorCatalogRuntimeProjectionDigest` | Obsolete digest corruption helper after retiring the mixed-sync stage                                                    | Remove only that helper; other unmigrated corruption/full-snapshot mechanisms remain. Parent 5536's copied generation import was unused, not a retained caller; exact f5 removes that import                                                                                                | Full test-root type checking is required; the earlier narrow test project missed this integration import. No helper restoration or fake fallback. |
| Native N4                                               | No original case removed                                                                                                 | Existing MCP/hash/captured-hash/switchback/capability/metadata separation plus real runtime and diagnostic commands on the same actor/PGlite engine, one catalog statement each                                                                                                             | Retained source coverage; no locally executed native PASS claim.                                                                                  |
| Native N5                                               | No original case removed                                                                                                 | Existing MCP/empty-selection contracts plus runtime missing-entry rejection, unknown absent and diagnostic missing-current rejection; original four plus three command reads = seven; no R2/legacy fallback                                                                                 | Natural current-HEAD execution required.                                                                                                          |
| Parent Automatic publication cases                      | No case deleted by runtime owner                                                                                         | Parent's relocated cases stay in run-lifecycle generation file; shared fixed readers remain ordinary. Only necessary normal merge and formatting at the ordinary import seam                                                                                                                | Parent ownership/review remains separate.                                                                                                         |

Zero runtime-owned whole cases deleted; no sixth native case, ordinary PGlite, global lock, snapshot/restore, sleep, retry, timeout, test hook, fake response or production default-empty fallback is added.

## Original natural-CI failures (frozen evidence)

Run `37355070561` at the original runtime head is FAIL; cancelled work is not PASS.

- `lint-type-api`, job `111915431686`: first error TS2724 in `run-lifecycle.bdd.catalog-generation.test.ts:80`, importing the removed digest-corruption helper. The exact parent f5 cleanup removes its unused import. Local aggregate/test-root checks replace neither old failure history nor new CI.
- `lint-eslint`, job `111915431342`: first substantive warning is unused `http`; log ends 232 warnings/0 errors and exit 1. Returned annotations locate ten unused imports across Automatic/webhook generation files. Those located entries are inherited and addressed by exact parent cleanup; their locations do not establish attribution for all 232 warnings. No duplicate full-repository parent cleanup is performed.
- `test-api (3)`, job `111915431929`: Discord Gateway `rejects a signed timestamp outside the past/future window (301)` at `discord-gateway-auth.test.ts:113`, expected401/received200; 1 failed/51 passed files and 1 failed/1103 passed tests. The test creates its signature timestamp from one real clock read; the verifier uses a later integer-second clock read with a 300-second inclusive window. Crossing a second can change +301 to +300. This is a source-supported timing explanation, not observed clock telemetry or a declared flake. The unavailable GUILD_DELETE route returns ignored200 after signature verification without a runtime/catalog read. Discord authentication/time testing is outside this reader/stack repair, so the real failure is preserved and left unresolved rather than changing product policy or weakening its negative test.

## Authorized Discord test-clock supplement

After the stack integration at `992bd19f8c79486c5bcee2925908a1456295b420`, the coordinator separately authorized only the existing Gateway past/future negative cases' test-clock precondition. Both original offsets (−301/+301) and 401 assertions remain. The callback now awaits the existing API `withMockNowForTest` at `2026-10-05T12:00:00Z`, so timestamp construction, real HMAC signing and the real HTTP verifier read the same wall-clock reference. The AsyncLocalStorage scope restores the caller context on return or rejection; no global clock override, fake timer, new fixture, production clock parameter or manual teardown is added. Existing fixture abort/drain/clear/close ownership is unchanged.

The complete Gateway authentication file retains shared exact HMAC vectors/application403 body, changed-body401, malformed timestamp/signature401, untrusted owner400, unavailable-guild200 body, unsupported messages200 bodies, size413 and missing-configuration503. Existing success coverage uses zero timestamp offset; this file has no explicit accepted ±300 cases. The separate interactions-verification suite uses a different −300/+30 contract and is not Gateway boundary coverage. This supplement adds or deletes no case and does not claim to close that pre-existing coverage gap. Runtime/N4/N5, f5 generation grouping and the schema chain remain unchanged.

The original 9c2 incident remains FAIL with no recorded pair of clock values. This fixes a reproducible source-level precondition, not proof of the incident's unique cause or a runtime execution PASS. Non-author review must assess this actual test/ledger delta separately from the full runtime-owned implementation and normal integration; natural new-HEAD CI remains required.

## Authorized policy-projection test-contract supplement

At exact runtime HEAD `6376d202560a2c6382137823c077edd80c834440`, Turbo
`37362052438` attempt3 / API4 job
[112034202742](https://github.com/okou-ai/okou/actions/runs/37362052438/job/112034202742)
failed at `model-catalog-authority.test.ts:153`, "projects the system default
policy without storing a per-organization row". The GET and empty PUT differed
in `memberEffective.availability` (unavailable to available),
`memberEffective.runtimeProviderType` and top-level `runtimeProviderType` (null
to openrouter-codex). This remains a substantive historical FAIL, not a flake or
an exemption for the connector migration. The unique triggering key/candidate/
cooldown mutation remains UNKNOWN. The prior no-patch investigation is retained
at https://app.okou.ai/artifacts/cb38immndh.md; this later supplement follows the
coordinator's explicit decision to repair the unsupported test contract.

The public `OrgModelPolicy` response separates configured policy from
response-only member routing. `policyRevision` hashes persisted organization
policy rows; the projected system default is not persisted by empty PUT.
`listOrgModelPolicies` independently resolves Built-in keys, enabled catalog
candidates and selected-model cooldowns for each request. Consequently an
unchanged policy revision does not promise cross-request equality of those live
route facts. This source contract, not a reconstruction of the old CI timing,
is the repair basis. Production policy, revision and route behavior are unchanged.

| Retired cross-request assertion field | Why it is not a policy-revision promise                                                                                                                                 | Replacement / retained public coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level `runtimeProviderType`       | Administrative Built-in concrete provider comes from this request's `resolveBuiltInModelRuntimeRouteWithKeys`, not the stored policy row.                               | Existing UUID-owned "launches a new catalog model on a supported protocol from rows alone" retains exact openrouter-codex then openai-api-key provider assertions and unchanged revision; disabling its last executable route asserts public policy omission, not null availability. Existing `model-policies.test.ts` "advertises the current built-in provider for route-specific effort controls" retains public provider/null checks after a real Runner billing failure on an enabled model-owned mirror, now with unchanged policy revision. |
| `memberEffective.runtimeProviderType` | `memberPolicyProjection` uses the live Built-in route for this Built-in/org case; other member routes can differ from the administrative route.                         | The owned-model case strictly matches complete available member-effective objects for both concrete providers. The existing enabled-mirror Runner cooldown case now strictly matches the complete available/openrouter-codex then unavailable/null member objects. Neither asserts general administrative/member equivalence.                                                                                                                                                                                                                      |
| `memberEffective.availability`        | Member availability depends on scoped effective route and plan plus live org-route availability; Built-in key/candidate/cooldown facts are outside the policy revision. | Exact available member objects remain for both enabled providers. Exact unavailable is covered by the existing enabled-mirror Runner billing-failure cooldown case, not all-disabled catalog omission. Existing member/plan/permission/identity negatives below remain unchanged.                                                                                                                                                                                                                                                                  |

The repaired default case retains its real GET then empty PUT, original initial
system-default assertion, unchanged revision and therefore the original public
non-persistence evidence. A flat test-local projection removes exactly the three
named live fields, never arbitrary keys. Strict equality compares the entire
ordered policy array and every remaining field: ID/model/label, configured
provider/credential scope/provider and optional surface IDs, route status/reason,
created/updated times, any subscription options, member projection presence and
all remaining member provider/scope/account-selection fields. It is deliberately
scoped to this system-default/owned-member case, not a generic claim that every
policy field is frozen solely by revision.

The existing new-model case already owns a UUID catalog model, its two candidate
rows/pricing and its test-lifetime key leases. Candidate changes address only
that model; no global default/catalog reset or cooldown is written. Its selected-
model cooldown namespace has no other run writer, and the case creates no run.
Key seeding alone is not represented as freezing every shared fact. Existing
fixture teardown releases leases and deletes only owned model/routes/pricing.
No new case, fixture, matcher framework, hook, DB adapter, mock, sleep, retry,
timeout, serialization or production configuration is introduced.

Unchanged security and failure coverage remains at real public boundaries:

- `model-policies.test.ts`: "allows members to read policy controls" (200 and
  exact system-default models); "requires admins for policy writes" (403 and
  exact FORBIDDEN body); unauthenticated and missing-organization read/write401.
- "projects the seven subscription catalog entries only for the connected Auto
  member": connected caller's available personal route and exact catalog list;
  another same-org member sees only the system default, not those identities.
- `personal-subscription-run-identity.test.ts`, "keeps administrative GET and
  PUT fields identical for two real members": distinct member-effective routes,
  public JSON excludes personal account ID/token, member write403, and the
  other's member projection remains its own. No general member/admin identity
  relation is added by this repair.
- Existing provider-ID/route incompatibility400 negatives and the owned-model
  no-complete-pricing Run rejection remain. Native missing-entry/current,
  runtime/metadata union/fixed hash, N3 real competitors, N4/N5, five-engine
  lifecycle and Discord negative ±301 coverage are untouched.

No whole case or valid negative is retired. Only the unsupported cross-request
live-field equality is replaced, with stronger explicit owned public route
outcomes. Source coverage is not execution PASS. Scoped static checks and related
API types are required before commit; no local Vitest/native/PG replay. The new
full HEAD needs non-author delta review and its own natural CI. Historical FAIL,
mutation UNKNOWN, inherited source-review attribution and Preview/Pi/S1–S3
limits remain separate. No old run rerun is authorized.

Authoritative practice snapshot for this supplement is main
`2b27c989bca8da798f9f3d92aee9e90b2de77691`. Scoped ESLint max-warnings0,
Oxlint deny-warnings, the repository test type-aware configuration, complete API
aggregate types/boundary/chat-event-acceptance pipeline, Prettier and diff-check
passed. The type pipeline's Node boundary regressions are not API business or
native Vitest execution. Checks reused the exact-f5 locked toolchain after
verifying lockfile and workspace-package source parity; no dependency, DB or
environment configuration was repaired. These are author static results, not
independent source approval, natural-CI completion or runtime acceptance.

## Authorized R1 public-availability correction

The independent non-author review of `6376 → 8608` found a source-level P1
contradiction, not an observed CI failure: all-disabled catalog routes make the
model unsupported, so `projectPolicyRows` omits its stored policy before member
projection. The final phase now asserts that exact public omission and unchanged
revision. Production filtering and availability semantics are unchanged.

The existing UUID-owned mirror case in `model-policies.test.ts` keeps enabled
catalog routes, candidate key leases, paid Custom workspace, real Run admission,
heartbeat/claim, recorded Runner billing failure and cancellation/cleanup.
Its existing public PUT200 and GET200 now assert complete before/after
`memberEffective` objects (available/openrouter-codex → unavailable/null), the
existing top-level concrete-provider/null assertions, and unchanged revision.
The actual Runner failure path owns the cooldown; no direct cooldown injection,
global key change, new fixture/case or production hook is introduced. This
replaces the invalid unavailable phase with a supported public path without
weakening stable projection equality, permissions or security coverage.

All-disabled omission is **not** cooldown/unavailable coverage. The original
6376 cross-request mutation remains UNKNOWN and its FAIL is not a flake or a
reproduced cause. The R1 source correction requires independent actual-delta
review and natural exact-new-HEAD CI; author static checks are not acceptance.
No local Vitest/native/PG execution or recovery-budget reuse is authorized.

## Verification boundary

Read current main practices at `db21163887a248a206ba7bcfadfca4d8f73aaab5`, matching the prior authoritative review receipt. Use explicit-file ESLint/Oxlint with deny-warnings and repository type-aware configuration, formatting/diff checks, and the repository aggregate API type pipeline including regenerated complete test roots. Exact command results belong in the private owner handoff; none establishes runtime acceptance.

No local Vitest/native replay, dev server, PG/environment repair, Preview/Browser/Axiom/provider sampling, parent/account branch modification or production action. Keep Draft and auto-merge off. Current-HEAD non-author review, natural CI, applicability of any business failure, and separately authorized Preview remain required. Historical FAIL/CANCELLED, unknowns and limits are not rewritten.
