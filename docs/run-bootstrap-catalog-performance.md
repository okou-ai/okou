# Run bootstrap catalog performance

## Scope

Avoid eagerly transferring and decoding the entire catalog during Run bootstrap when the existing scoped runtime projection is available. Preserve existing connector credential, skill/storage mounting, firewall, permission baseline, Pi identity, account, OAuth and claim behavior.

`createConnectorContextGroups` already computes the runtime and metadata connector slug union. Bootstrap now passes that union to the existing `loadConnectorRuntimeSelection` reader. That reader reads the projection identity and selected entries, retains its existing capability filtering/cache and preserves the existing full fallback for unavailable or incomplete projections. This is not an unconditional elimination of all full-catalog reads: fallback and unrelated endpoints remain unchanged.

The former bootstrap graph captured `catalogGzip` before knowing whether the selected projection rows were sufficient, then started accepted-payload decoding before choosing the projection. Remove that graph and its now-unused private capture/cache-peek helpers. Do not change the shared loader, publisher, Pi invalidation/registration, baseline schema, Runner claim or database schema.

## Regression coverage

Retain the ordinary bootstrap file's remaining 13 cases. Relocate its catalog-rotation case to the existing catalog-generation project: publish A and B through the production cron route, pause after the selected projection-entry read, rotate, and verify the first claim retains the captured account metadata while the next claim omits the removed connector. The barrier observes selected connector payload rows rather than the retired full-gzip capture. No new test project, timeout, sleep or retry is added.

Account/selection and original Pi/claim behavior are restored to main, not redesigned. The closed account/OAuth/Pi PRs' former content is no longer part of the final main-relative diff, although their commits remain in branch history. Historical integration CI does not certify this reduced HEAD. No production activation or performance timing improvement is claimed without a separately observed Run measurement.
