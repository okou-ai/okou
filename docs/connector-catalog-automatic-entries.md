# Automatic OAuth immutable entries (O1a)

## Stack and behavior

This batch is based on account commit `2543cdff2b1085a60832c81a19da2813dbcd8ea6` and targets `refactor/catalog-account-lifecycle`. It does not update that branch or the runtime sibling. It depends on the inherited immutable publisher, entries reader and account lifecycle changes; it is not independently deployable on current main.

The public Automatic start route obtains an action resolver from one immutable selection of its requested slug. The existing resolver's pure method/executable/grant checks are reused with a typed lookup; other resolver entrances retain their existing snapshot types and behavior. No legacy identity is fabricated and no catalog adapter is introduced.

Start passes the selection's actual `{schemaVersion, hash, capabilityDigest}` to the DCR insert owner. Following provider registration, that owner checks the schema's current hash against the captured hash before persisting the same owner/contract/issuer-bound registration. A changed hash remains binding drift; missing current is a hard invariant failure. This preserves the existing pre-insert check, not an atomic CAS fence or a new lock guarantee. DCR rows remain bound by org/slug/method/contract hash; they do not persist the legacy catalog identity and need no C-owned identity conversion or migration.

The independently arriving callback makes its own necessary immutable selection. Its endpoint/storage-version/contract-hash comparison to frozen consent remains before token exchange. It does not reuse a previous request's current pointer. State claiming, redirect/PKCE/issuer validation, token destinations, account publication, completion receipts, DCR retirement and post-commit wakeup/cancellation ordering are unchanged.

## Retirement ledger

| Mechanism                                                            | This batch                                                                  | Public coverage retained or added                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic start's whole legacy snapshot read                         | Replaced by requested-slug immutable selection                              | Ordinary fixed-catalog no-auth/CIMD/OIDC/DCR connect/reconnect cases; native N5 unknown slug and missing manifest/current negatives       |
| Automatic callback's whole legacy snapshot read                      | Replaced by a fresh requested-slug immutable selection                      | Generation suites' frozen storage contract and endpoint-change consent rejection; ordinary issuer mismatch, replay and cancellation cases |
| DCR insert's legacy active-snapshot identity query                   | Replaced by schema current/hash comparison using the real captured identity | Ordinary DCR reuse/expiry/invalid-client retirement and temporary-failure account retention cases; no new executed concurrency claim      |
| Legacy resolver entrances, regular OAuth/OpenID callback             | Retained, outside O1a                                                       | Existing callers are not migrated by the generic pure resolver typing                                                                     |
| Automatic credential/refresh `currentContract` and destination reads | Retained, outside this start/callback seam                                  | No refresh, firewall-auth or token-publication behavior rewritten; a later owner must migrate these remaining legacy reads                |
| Generation files, fixture publishers, lifecycle barriers             | Retained in full                                                            | No case/group/engine retirement; no replacement mock or shared-catalog mutation added                                                     |

Native N5 uses its existing case-owned PGlite engine and actual public Automatic route. The write capability is requested only by that new helper; existing directory helpers retain read-only tokens. Missing known entry and missing current expect the Automatic contract's declared HTTP 500 (account's existing undeclared-status rejection stays unchanged). Existing native N1 TODO, expected setup failure, N2–N4 and teardown ownership remain unchanged. Ordinary business coverage remains real PostgreSQL with the fixed shared catalog.

## Verification boundary

Scoped formatting, ESLint, Oxlint including type-aware analysis and the API aggregate/boundary/acceptance type checks are static verification only. Local Vitest, PostgreSQL execution, provider OAuth, Preview, performance and CAS/concurrency acceptance are not executed in this batch. Historical parent failures/cancellations are not backfilled. Natural CI on the new Draft PR and independent current-head review remain necessary; no merge/release authority is exercised.
