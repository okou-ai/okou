# Batch 019: normal paid-tool construction and export admission

Refs #37440. Preimplementation selection recorded against main `69bf326e077760ed6e622b6c5ced1b242dd601f8`. Sole implementation owner; exactly ten frozen identities. Opening: 58 helpers (29 shared / 29 local) + 21 HTTP operations / 18 paths / 102 original nested actions. No deduction until GitHub MERGED.

Current append-only ledger: https://github.com/okou-ai/okou/issues/37440#issuecomment-6073166299 (page 010); page 009 and all history retained.

## Ten frozen identities

| #   | Original file + symbol / operation                                                            | Disposition                                        |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `turbo/apps/api/src/signals/routes/__tests__/scrape.test.ts::setActorCredits`                 | Retire                                             |
| 2   | `turbo/apps/api/src/signals/routes/__tests__/scrape.test.ts::createScrapePricingFixture`      | Retire                                             |
| 3   | `turbo/apps/api/src/signals/routes/__tests__/scrape.test.ts::createAdmittedScrapeRun`         | Public rewrite                                     |
| 4   | `turbo/apps/api/src/signals/routes/__tests__/people-search.test.ts::createPricingFixture`     | Retire                                             |
| 5   | `turbo/apps/api/src/signals/routes/__tests__/social.test.ts::setupConfiguredPricing`          | Retire                                             |
| 6   | `turbo/apps/api/src/signals/routes/__tests__/social.test.ts::fundActorWithSubscription`       | Public rewrite                                     |
| 7   | `turbo/apps/api/src/signals/routes/__tests__/social.test.ts::prepareScenario`                 | Public rewrite                                     |
| 8   | `turbo/apps/api/src/signals/routes/__tests__/social-downloads.test.ts::configuredFixture`     | Public rewrite                                     |
| 9   | `turbo/apps/api/src/test-fixtures/socialkit-download.ts::deleteSocialKitDownloadJobsForOwner` | Retire                                             |
| 10  | `POST /api/test/user-export-work`                                                             | Retire all seven actions and orphan route/contract |

## Scenario decisions, recorded before implementation

- Scrape: retain provider success/error, security, cancellation, CLI and exact 4/20-credit billing. Replace case-specific price aliases with the existing immutable dev-seed catalog. Replace arbitrary credit writes / private key / fabricated Run credentials with normal Pro activation, personal model authorization, actual Run claim and claim-issued token. Starting at zero cash retains admitted-tool debit to -4, not the old 1-to-0 exhaustion transition. Real Stripe cancellation retains suspended-plan rejection and no provider call. Remove only the manufactured price-deletion-after-success case.
- People Search: retain bounded output, source deduplication, twenty-profile maximum, no-results billing, invalid-output/provider-error no-charge, CLI and insufficient-credit behavior at the existing 20-credit tariff. Remove only the selected missing-price branch; preserve missing-provider configuration 503.
- Social: retain all content, pagination, redaction, provider failures, media-format and multipart matrices at the existing 3-credit tariff. Actual claimed Runner credentials replace positive fabricated tokens, including both Instagram caller rows and all views branches. Normal GET drives expired-download recovery; lose private cron processed counters. Remove manufactured price-deletion failure and internal reconciliation-timeout-control cases; ordinary provider timeout/cancellation cases remain.
- Full selected funding chains: normal onboarding and Stripe activation, normal credit checkout capturing actual outbound invoice metadata, then invoice.paid; preserve original starting balances and exact debit assertions. Join owned work, cancel/ACK claimed Runs, delete Agents while owner exists, deliver genuine organization.deleted callback. Remove private download-row deletion and unsupported reads impersonating a deleted organization. Unique actors share PostgreSQL; no per-case database or replacement business cleanup is claimed.
- Export: normal POST budget is ten steps, insufficient even for an empty completed archive (collection plus scan/inventory/manifest/upload/authorize/publish/notify). Repeated active POST does not execute again and GET is read-only. Keep public admission, active-job coalescing/status and owner isolation. Remove internal-worker-driven ZIP/completion/cooldown-after-completion/expiry/restart guarantees; keep independently useful normal resource publication/reads from the composite case rather than delete the entire public setup. Official catalog revision keeps normal accepted-instruction observation; its existing private catalog construction remains unprocessed, not certified. Production worker budgets, locks, scheduling, billing and ordinary routes stay unchanged.
- Fixed baseline infrastructure: extend both existing once-per-run shared/isolated seed filters only to already defined dev-seed Scrape, SocialKit and People Search rows, using existing onConflictDoNothing. No invented tariff or case-specific DB writer. These seed helpers remain unprocessed and count zero. Image default prices, Monid pricing, built-in exact-two-token accounting, Storage wrappers, limited-free fake tokens, Unread matrices, System cache/Run/Pi/projection/connector/service-import boundaries remain unresolved.

## Complete caller census at opening main

The following records every declaration in each selected local helper's module, including factory/closure setup and teardown, to expose both direct and indirect funding/pricing context, without claiming every neighboring declaration used a selected helper. Cross-module shared cleanup has exactly Social and Social Downloads consumers. Export has exactly ops-logs BDD and Official Workflow consumers. No benchmark or service consumer was found by repository-wide symbol/route search. Files, case names and direct helper call sites below are evidence, not extra quota.

### scrape.test.ts

Direct calls: `setActorCredits@381`, `createUsagePricingFixture@416`, `fundActorWithSubscription@495`, `fundActorWithSubscription@557`, `createScrapePricingFixture@836`, `createScrapePricingFixture@869`, `createAdmittedScrapeRun@870`, `setActorCredits@871`, `createScrapePricingFixture@912`, `createAdmittedScrapeRun@913`, `createScrapePricingFixture@961`, `fundActorWithSubscription@962`, `createScrapePricingFixture@1028`, `fundActorWithSubscription@1029`, `createScrapePricingFixture@1080`, `fundActorWithSubscription@1081`, `createScrapePricingFixture@1131`, `fundActorWithSubscription@1132`, `createScrapePricingFixture@1191`, `fundActorWithSubscription@1192`, `createScrapePricingFixture@1235`, `fundActorWithSubscription@1236`, `createScrapePricingFixture@1298`, `fundActorWithSubscription@1299`, `createScrapePricingFixture@1342`, `fundActorWithSubscription@1343`, `createScrapePricingFixture@1388`, `fundActorWithSubscription@1389`, `createScrapePricingFixture@1461`, `fundActorWithSubscription@1462`, `createScrapePricingFixture@1503`, `fundActorWithSubscription@1504`, `createScrapePricingFixture@1542`, `fundActorWithSubscription@1543`, `createScrapePricingFixture@1580`, `fundActorWithSubscription@1581`, `createScrapePricingFixture@1627`, `fundActorWithSubscription@1628`.

- rejects agent tokens without scrape:read capability
- returns a sanitized 503 when Clerk membership reads remain unavailable
- stops Clerk membership retries when the API instance is aborted
- keeps successful Clerk membership misses on the unauthorized path
- does not retry direct Clerk session %s failures
- rejects scrape requests when the provider is not configured
- blocks private targets before calling Firecrawl
- blocks special-use IPv4 literal targets before calling Firecrawl
- blocks non-public IPv6 literal targets before calling Firecrawl
- blocks target URLs with embedded credentials before calling Firecrawl
- returns insufficient credits before calling Firecrawl
- continues an admitted run after credits are exhausted
- does not let admitted runs bypass plan suspension
- scrapes markdown through standard Firecrawl proxy and records usage
- records usage when the request aborts after Firecrawl succeeds
- does not start Firecrawl when the request aborts before provider launch
- cancels Firecrawl when the request aborts while it is in flight
- stops in-flight Firecrawl work when the instance lifecycle aborts
- records both concurrent same-org scrape requests
- returns successful content when usage processing records a billing error
- scrapes public IPv6 literal targets without DNS lookup
- scrapes links through enhanced Firecrawl proxy and records usage
- rejects unsafe final URLs when the source URL is public
- returns Firecrawl success false errors without recording usage
- bounds provider error messages without recording usage
- rejects provider data without an explicit success marker
- rejects oversized Firecrawl responses without recording usage

### people-search.test.ts

Direct calls: `createUsagePricingFixture@356`, `createUsagePricingFixture@360`, `createPricingFixture@517`, `fundActorWithSubscription@518`, `createPricingFixture@646`, `fundActorWithSubscription@647`, `createPricingFixture@693`, `fundActorWithSubscription@694`, `createPricingFixture@723`, `fundActorWithSubscription@724`, `createPricingFixture@747`, `fundActorWithSubscription@748`, `createPricingFixture@769`, `fundActorWithSubscription@770`, `createPricingFixture@841`, `fundActorWithSubscription@842`, `createPricingFixture@880`, `createPricingFixture@908`, `fundActorWithSubscription@909`, `createPricingFixture@973`, `fundActorWithSubscription@974`.

- rejects agent tokens without people-search capability
- sends one bounded tool request and returns provider-backed profiles
- accepts a CLI token
- deduplicates by validated source identity before enforcing the response budget
- returns twenty profiles at the supported maximum
- bills a valid search with no matching profiles
- rejects invalid provider/model output without billing
- fails before provider work when configuration or pricing is absent
- rejects insufficient credits before provider work
- maps provider failures without billing
- maps and bounds nested provider errors without billing

### social.test.ts

Direct calls: `deleteSocialKitDownloadJobsForOwner@226`, `createUsagePricingFixture@408`, `setupConfiguredPricing@502`, `fundActorWithSubscription@503`, `setupConfiguredPricing@556`, `fundActorWithSubscription@557`, `setupConfiguredPricing@585`, `fundActorWithSubscription@586`, `setupConfiguredPricing@660`, `fundActorWithSubscription@661`, `setupConfiguredPricing@696`, `fundActorWithSubscription@697`, `setupConfiguredPricing@782`, `fundActorWithSubscription@783`, `setupConfiguredPricing@852`, `fundActorWithSubscription@853`, `setupConfiguredPricing@931`, `fundActorWithSubscription@932`, `setupConfiguredPricing@970`, `fundActorWithSubscription@971`, `setupConfiguredPricing@1073`, `fundActorWithSubscription@1074`, `setupConfiguredPricing@1186`, `fundActorWithSubscription@1187`, `setupConfiguredPricing@1232`, `fundActorWithSubscription@1233`, `fundActorWithSubscription@1366`, `setupConfiguredPricing@1367`, `fundActorWithSubscription@1424`, `setupConfiguredPricing@1425`, `fundActorWithSubscription@1459`, `setupConfiguredPricing@1460`, `fundActorWithSubscription@1526`, `setupConfiguredPricing@1527`, `fundActorWithSubscription@1554`, `setupConfiguredPricing@1555`, `fundActorWithSubscription@1692`, `setupConfiguredPricing@1693`, `setupConfiguredPricing@1734`, `fundActorWithSubscription@1735`, `setupConfiguredPricing@1811`, `fundActorWithSubscription@1812`, `setupConfiguredPricing@1880`, `fundActorWithSubscription@1881`, `fundActorWithSubscription@2006`, `setupConfiguredPricing@2007`, `setupConfiguredPricing@2043`, `fundActorWithSubscription@2044`, `setupConfiguredPricing@2164`, `fundActorWithSubscription@2165`, `setupConfiguredPricing@2394`, `fundActorWithSubscription@2395`, `setupConfiguredPricing@2569`, `fundActorWithSubscription@2570`, `setupConfiguredPricing@2637`, `fundActorWithSubscription@2638`, `setupConfiguredPricing@2665`, `fundActorWithSubscription@2666`, `setupConfiguredPricing@2713`, `fundActorWithSubscription@2714`, `setupConfiguredPricing@2833`, `fundActorWithSubscription@2834`, `setupConfiguredPricing@2874`, `fundActorWithSubscription@2875`, `setupConfiguredPricing@2921`, `fundActorWithSubscription@2922`, `setupConfiguredPricing@2971`, `fundActorWithSubscription@2972`, `setupConfiguredPricing@3003`, `fundActorWithSubscription@3004`, `setupConfiguredPricing@3045`, `fundActorWithSubscription@3046`, `setupConfiguredPricing@3286`, `fundActorWithSubscription@3287`, `setupConfiguredPricing@3359`, `fundActorWithSubscription@3360`, `setupConfiguredPricing@3384`, `fundActorWithSubscription@3385`, `setupConfiguredPricing@3421`, `fundActorWithSubscription@3422`, `prepareScenario@3433`, `setupConfiguredPricing@3492`, `fundActorWithSubscription@3493`, `setupConfiguredPricing@3578`, `fundActorWithSubscription@3579`, `setupConfiguredPricing@3610`, `fundActorWithSubscription@3611`, `setupConfiguredPricing@3706`, `fundActorWithSubscription@3707`, `setupConfiguredPricing@3776`, `fundActorWithSubscription@3777`, `setupConfiguredPricing@3904`, `fundActorWithSubscription@3905`, `setupConfiguredPricing@3954`, `fundActorWithSubscription@3955`, `setupConfiguredPricing@4045`, `fundActorWithSubscription@4046`, `setupConfiguredPricing@4105`, `fundActorWithSubscription@4106`, `setupConfiguredPricing@4218`, `fundActorWithSubscription@4219`, `setupConfiguredPricing@4499`, `fundActorWithSubscription@4500`, `setupConfiguredPricing@4575`, `fundActorWithSubscription@4576`, `setupConfiguredPricing@4764`, `fundActorWithSubscription@4765`, `setupConfiguredPricing@4831`, `fundActorWithSubscription@4832`.

- returns provider data when billing fails after success
- rejects agent tokens without social:read capability
- accepts valid requests without a feature override
- preserves Instagram views and duration for %s callers
- forwards Instagram requireViews=%s and bills verified zero once
- preserves only the documented strict Instagram 503 without billing or retry
- preserves strict Instagram lookup advice with explicit nonretryability without billing
- rejects requireViews on an unsupported managed tool before provider I/O
- serializes %s extraction refresh independently of result caching
- rejects unsupported extraction refresh before a provider request
- preserves structured caption absence after refreshing extraction
- applies reviewed TikTok limits while preserving raw session results
- projects TikTok agent results and exposes unreliable empty uncertainty without retry
- rejects conflicting TikTok aliases before usage settlement
- accepts agent tokens and attributes usage to their run
- forwards $path with only managed auth
- rejects invalid Instagram searches before provider work or billing
- normalizes Instagram queries and reports every anonymous batch as source-limited
- accepts the documented Instagram stats URL %s
- maps typed tools to canonical GET requests without a body
- forwards documented pagination, filter, cache, and customization fields
- settles result-metered pages from validated returned item counts
- normalizes every reviewed pagination shape
- uses Instagram comment outcomes and treats comment counts as advisory
- rejects contradictory Instagram comment continuation without billing
- uses reported comment totals to prevent false completion
- rejects invalid collection successes without billing
- rejects $caseName before provider work
- rejects requests when SocialKit is not configured
- preserves non-input provider failures for $path / $providerStatus without billing
- normalizes $errorCode / $providerStatus with explicit retry guidance
- surfaces bounded Retry-After: $header
- maps provider HTTP failures without recording usage
- classifies documented transcript availability signals without billing or retries
- rejects invalid or credential-leaking successes without billing
- rejects declared and streamed oversized responses before billing
- maps timeout and network failures without recording usage
- does not record usage when the client aborts during provider work
- records usage when the client disconnects after provider success
- records concurrent multi-unit requests exactly once each
- rejects $caseName without settlement
- files $caseName by its detected media
- reports detected M4A bytes truthfully for an MP3 request
- preserves the complete scenario
- marks $caseName artifact output billed and retryable
- rejects credential-bearing download URLs before provider work
- allows only one active download per user
- does not expose download state to another user
- retains the same download after polling $providerStatus and honors its delay
- preserves submission error $reason without repeating the POST
- keeps transient provider polling failures unbilled and retryable
- defers a claimed download when its reconciliation budget expires
- reconciles an expired claimed download through the bounded cron batch
- reuses completed multipart output without rebilling (private=%s)
- keeps $errorCode terminal while retaining new-submission advice
- preserves bounded provider download diagnostics
- uses a safe fallback for $caseName
- rejects a ready response for a different platform without billing

### social-downloads.test.ts

Direct calls: `createUsagePricingFixture@77`, `deleteSocialKitDownloadJobsForOwner@137`, `configuredFixture@361`, `configuredFixture@434`, `configuredFixture@523`, `configuredFixture@609`.

- requires authentication, an organization, and the social capability
- rejects invalid page query %s
- bounds default pages and continues after exact database anchors despite new insertions
- recovers submitting and processing task identities without causing provider work
- isolates listing, cursor anchors, reads, and active conflicts across users and organizations
- redacts provider diagnostics in agent download lists while retaining requested social content

### ops-logs.bdd.test.ts

Direct calls: `runExportWork@88`, `runExportWork@264`, `runExportWork@312`, `completedExport@514`.

- rejects unauthenticated and org-less export requests
- exports durably with active, cooldown, expiry, and latest-job visibility
- exports owned threads, instructions, workflows, and current memory in format v4

Official Workflow direct consumer: `exports the accepted Official Workflow instruction after a catalog revision`; keep the accepted-instruction public read, remove only the completed-export phase. All aliases (`pricing`, `resolution`, factory return values, `registerCleanup`, `registerDownloadOwner`, operation-owner closures), setup/teardown, route imports, package exports and lint exceptions will be rechecked after the edit.

## Validation and accounting

Pending implementation census, independent exact-HEAD review, required PR CI and protected merge queue. No local Vitest or dev server. Retired helpers 5, publicly rewritten helpers 4, HTTP operations retired 1 is the planned disposition, not yet a completed deduction. Final receipt belongs in the append-only ledger.

## Implemented coverage and zero-credit cleanup

Five helpers are retired (four local, one shared), four local helpers are fully publicly rewritten, and one HTTP operation is retired: exactly ten original identities. The two original pricing seed helpers, new public-flow support, aliases, returned methods and extracted resource phases count zero. All nine helper identities are distinct from batches 001–018.

Module census (includes unchanged neighbors; renamed cases are retained, not delete-plus-add credit):

| Module                     | Before declarations / parameter executions | After declarations / parameter executions |
| -------------------------- | -----------------------------------------: | ----------------------------------------: |
| scrape.test.ts             |                                    27 / 28 |                                   25 / 26 |
| people-search.test.ts      |                                    11 / 11 |                                   10 / 10 |
| social.test.ts             |                                   58 / 151 |                                  55 / 148 |
| social-downloads.test.ts   |                                     6 / 11 |                                    6 / 11 |
| ops-logs.bdd.test.ts       |                                      3 / 3 |                                     3 / 3 |
| official-workflows.test.ts |                                    37 / 44 |                                   37 / 44 |

Total across these six modules: **142 declarations / 248 parameter executions → 136 / 242**. Six single-execution cases are removed; no retained parameter row is dropped. Module totals are not claimed as six-module public certification: the other 36 Official Workflow declarations and their private catalog/storage chains remain outside this batch.

Removed case declarations and precise reasons:

1. Scrape `rejects agent tokens without scrape:read capability`: locally signed absent-capability combination with fabricated Run identity; normal claimed tokens do not construct it. Lose that synthetic 403 combination, retain real-claim paid-tool authorization and normal unauthenticated/error coverage.
2. Scrape `returns successful content when usage processing records a billing error`: provider handler privately deletes selected pricing between execution and settlement. Lose this injected post-success pricing disappearance; ordinary provider/billing success and failure branches stay.
3. People Search `rejects agent tokens without people-search capability`: same unsupported fabricated-token combination; normal CLI/auth cases stay.
4. Social `returns provider data when billing fails after success`: same private price-deletion fault injection; actual successful content and exact charge remain.
5. Social `rejects agent tokens without social:read capability`: same fabricated-token combination; actual Runner content redaction and run attribution stay.
6. Social `defers a claimed download when its reconciliation budget expires`: replaces the internal 280000-ms timeout controller, not an external user operation. Lose exact internal budget deferral; retain ordinary request cancellation, provider retry/error behavior and normal GET-driven recovery.

Split phases: Social Downloads keeps unauthenticated/org-less rejection and empty listing while removing only its fabricated capabilities=[] 403 subphase. People Search keeps absent-provider 503/no outbound while removing only private selected-missing-price 503. Instagram retains both session/Runner rows and all four views values (eight inner combinations). Download discovery retains the original 21 initial submissions and continuation/new-insert anchors; media signatures, unknown-container describe.each rows, private/public multipart branches and all other parameter rows remain.

Funding now uses normal one-time credit purchase (1000 / 10000 credits), actual outbound checkout invoice metadata and invoice.paid, replacing forged auto_recharge grants. The purchase has the ordinary purchase expiry; this is not equivalent to arbitrary never-expiring auto-recharge fixture state. Existing tool debit/no-charge assertions retain their exact amounts.

The export composite retains public Agent instructions, Workflow content, pinned Thread owner isolation and actual Runner memory publication: old version → current text/binary version, separate peer memory identity, then a new real claim mounting the current version. Its S3 boundary supplies SHA-matching bytes only at real prepare-authorized keys via the already merged memory helper; this is not an actual HTTP PUT. No complete ZIP, ZIP manifest format/hash/size consistency, exported owner/peer exclusion, old-version exclusion from an archive, attachment disposition, completed-job cooldown, expiry or restarted/latest-completed export guarantee remains. The Official case retains only accepted instruction read after revision; its private catalog construction is expressly unprocessed.

Zero-credit orphan cleanup removes the ZIP reader helpers and private `reconcile-socialkit-downloads` action/wrapper/response counter/worker candidate-ID argument. Repository-wide callers showed that candidate-ID selector had only the removed test action; production cron always supplied `{}`. Production scan bounds, stale threshold, locks/claims, per-job reconciliation, accounting and normal routes are preserved. The parent runtime-state HTTP operation is still incomplete. No GitHub workflow or CI configuration changes.

API delta: one operation and one path, seven original export actions plus one now-orphan runtime action removed. If and only if this exact batch merges, closing balance is **49 helpers (28 shared / 21 local / 0 benchmark) + 20 operations / 17 paths / 94 original actions**; cumulative **190 identities = 164 helpers (143 retired / 21 publicly rewritten) + 26 operations**.

Static validation: scoped ESLint/Oxlint, formatting and diff checks passed; Knip completed with configuration hints and no unused-code findings. Full repository type checks and runtime PR CI are recorded in the ledger when terminal. No local Vitest or dev server ran. Independent candidate review caught ordinary credit-price env configuration and an obsolete funder argument before commit; both were corrected. Exact-HEAD independent review and protected queue remain mandatory.
