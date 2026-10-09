# Model identity PR2: new writers and captured-runtime billing

This is release **2 of the agreed three releases**, following
[#38092](https://github.com/okou-ai/okou/pull/38092). The deployed API code
version selects its writer behavior. There is no database switch, phase row,
write-version marker, normalization trigger, or new feature switch.

**Do not promote this writer until the prerequisites below are verified.**
This implementation is not permission to merge, deploy, approve a deployment,
change production prices/configuration, or convert history.

## Writer ownership

| Surface                            | New behavior                                                                                                                                                                                     | Retained behavior                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member creation / model preference | New member rows explicitly select `auto`; nullable and explicit public Auto intents write `auto` and no service tier. Unrelated member updates do not overwrite an existing selection.           | Existing null/legacy rows remain readable; unavailable-personal and media-only echo admission rules remain.                                                                      |
| Thread creation                    | The existing default/preference resolution produces a nonempty personal ID or `auto`. Shared INSERT plans, integration publication and workflow thread creation use canonical Auto.              | Existing threads are not rewritten by a census or by an omitted send field.                                                                                                      |
| Thread model updates / normal send | Explicit null/`auto` means canonical Auto. An omitted model means no change. Model annotations for newly resolved decisions use the resolved selected ID.                                        | Public explicit `okou-1.0` stays rejected. Internal legacy captures remain readable.                                                                                             |
| Input queue                        | Newly resolved input decisions select `auto`; a consumed captured PR1 decision retains its captured `okou-1.0`.                                                                                  | SQL NULL for the entire `model_selection` remains an uncaptured decision. Unrelated event types do not acquire model fields.                                                     |
| Run launch and consumption         | The existing launch captures runtime model/provider, exact managed key or personal account, dialect, transport, credential bindings and capabilities in Run metadata and the execution snapshot. | Queued execution snapshots, active jobs and late producers are consumed without rerouting through today's org preset. Failed/unresolved lifecycle records may remain incomplete. |
| Effort preferences                 | New thread/workflow/integration preference copies exclude `auto`, `okou-1.0` and runtime-preset keys; personal effort entries survive. Auto rejects effort and Fast.                             | Saved historical settings and identity metadata remain readable. Existing settings are not mass-normalized.                                                                      |

Runless queued inputs are selection decisions, not executable jobs. The existing
admission owner resolves the execution once when creating its Run; this PR does
not add a second routing decision or an execution snapshot to the public input
selection protocol. After execution capture, later org changes cannot replace
its runtime/account/key/dialect. Captured PR1 inputs are not relabeled as PR2
inputs when they are consumed.

The shared `AUTO_RUN_MODEL` constant still names legacy catalog/capture metadata,
not the new selected identity. Keep the legacy Auto catalog, replacement lineage,
nullable `/api/run-models` Auto choice and predecessor-compatible client request
intents through the explicitly bounded response window below. Selecting null is
an intent, not the new persisted identity.

## Billing ownership

- New selected `auto` uses the captured runtime preset, such as
  `@preset/okou-1-0`, for preflight, addon reporting and settlement. Final billing
  preparation requires the captured runtime route; it cannot substitute the
  current catalog/org preset when that capture is absent.
- The authenticated Runner usage publication boundary pins `kind: model`
  observations for a canonical Auto Run to `agent_runs.model_runtime_model`.
  An upstream response's model name, `auto`, or the old selection key cannot
  change that attribution. Incomplete canonical runtime metadata fails closed.
- Already captured `okou-1.0` jobs keep their original billing key/rates and late
  reporting support. Personal subscription model observations remain filtered
  out of platform billing. Tool/image/connector observations retain their
  existing owners and identities. Pi memory Stage 1 / Phase 2's fixed
  `gpt-6-luna` maintenance binding is explicitly independent of foreground Auto;
  its pricing/reporting domain is unchanged.
- Preflight still requires all four token categories and their long-context
  variants. Newly selected canonical Auto captures the approved Haiku tariff's
  inclusive billing boundary of **100001 total input tokens**, including Luna
  fallback. Retained legacy captures keep **272001** and their original prices;
  already serialized execution configurations are not rewritten. This is a
  billing-policy boundary, not a change to runtime model capabilities. The DSF
  tariff is identical on both sides of that boundary. Auto has no Fast categories. The existing same-provider
  `__fallback__` lookup is not a license to borrow another preset's economics;
  it requires its own approved category coverage.
- If a captured preset observation loses its authoritative price before
  settlement, preparation throws before settlement writes. The observation
  stays pending for normal retry after approved pricing is restored; it is not
  settled at zero. This can hold the containing settlement batch. Keep pricing
  available for the full execution/reporting/rollback window, including PR1
  settlement owners. No historical or settled amounts are updated here.
- Runtime-key reporting and SQL grouping remain as prepared in PR1. The repeated
  literal `'auto'` SQL expressions and their driver decoders are unchanged.

## Pricing provenance and owner-approved tariff

A read-only MaskDB inventory on **2026-10-09 UTC** queried the complete
`usage_pricing` model projection (247 rows, limit 1000, returned 247) and all
non-null `org_metadata.openrouter_preset` values (1 row, limit 1000, returned 1).
Only identities/categories/counts are recorded here; no user/org IDs or raw
financial records are published.

The source default is `@preset/okou-1-0`; the observed override is
`@preset/okou-1-0-dsf`. Neither identity had a model pricing row (including a
provider fallback). Legacy `okou-1.0` had 16 categories, but that is **not**
authority to copy rates or evidence that either preset has approved economics.
The OpenRouter provider preset definitions and approved per-preset rates were
not established by this inventory.

After that inventory, Ethan explicitly approved **Haiku 5.5 pricing for the
whole default preset, including Luna fallback**, rather than response-model
pricing. Sources verified on 2026-10-09 UTC:
[Anthropic](https://www.anthropic.com/claude-haiku-5-5),
[OpenRouter's DeepSeek endpoint](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)
and [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/).

| Preset / tier               | Input | Output | Cache read | Cache creation |
| --------------------------- | ----: | -----: | ---------: | -------------: |
| Default, at most 100K input |   100 |    500 |         10 |            125 |
| Default, over 100K input    |   500 |   2500 |         50 |            625 |
| DSF, either tier            |   300 |   1200 |          6 |            300 |

Values are credits per million tokens ($1 = 1000 credits). Haiku uses the
5-minute cache-write tariff, not the 1-hour tariff. DSF uses the official
DeepSeek endpoint's standard/peak list price, not dynamic off-peak/provider
discounts. Cache creation is priced as uncached input, not a separate premium.
This is the approved platform tariff, not pass-through actual upstream cost.

Migration `1356_price_canonical_auto_presets` adds all 16 rows. It accepts an
operator's identical pre-seed and refuses a conflicting live tariff; all legacy
prices and settled amounts remain unchanged. It adds no switch or constraint.
There were **no production SQL/config writes**. Before promotion, verify the
migration actually ran and refresh all enabled presets: any other preset still
needs explicit approved coverage. Installed-client/runtime, serving/rollback
and native-history acceptance gates below remain unresolved. Missing prices
still reject execution; that is not an activation substitute.

## Mixed-version matrix and response window

| Producer / consumer                            | Contract                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR1 API -> PR2 API                             | Nullable member/thread preferences and captured legacy selections remain legal. Legacy jobs and late usage retain legacy billing. No pre-API NOT NULL or conditional constraint is added.                          |
| PR2 API -> PR1 API                             | PR1 reads canonical `auto`, captured runtime configurations and runtime-key observations. Preserve prices, catalog metadata and native session readers for PR1 serving/rollback.                                   |
| PR2 API -> pre-PR1 API/runtime                 | Unsupported after canonical records are emitted. Exclude those versions from serving and supported rollback before activation.                                                                                     |
| PR1/PR2 clients -> PR1/PR2 API                 | Public nullable/explicit Auto intent remains accepted. Omission preserves personal selections. The public legacy catalog and nullable Auto choice remain compatible; no new-only catalog response is introduced.   |
| PR2 captured job -> supported installed CLI/Pi | Require a verified PR1-capable package/installed execution path. Runner generation capability alone does not establish its CLI/Pi version.                                                                         |
| Completed PR1/PR2 native history -> mixed API  | Auto aliases remain the same family in both directions, while harness, genuinely different model families and null boundaries remain distinct. Retained native histories require independent restoration evidence. |

The compatible catalog/choice response window lasts until supported Web,
Desktop, CLI and iOS consumers all understand canonical Auto and pre-PR1 API
rollback is excluded. A Web floor cannot close the CLI/iOS gate. Removal belongs
to [#38114](https://github.com/okou-ai/okou/issues/38114), together with the
retained null/legacy readers and old catalog/pricing rows, after verified
producer, queue, installed runtime, retained-history and late-report drains.
There is no elapsed-time-only retirement criterion.

## Deployment evidence and prerequisites

Refreshed during implementation, not inferred from the release PR's merge:

- Production release [run 37865772815](https://github.com/okou-ai/okou/actions/runs/37865772815)
  completed successfully. Its migration, API, App Worker and x86_64 Runner
  promotion jobs succeeded. The observed schema exposes `usage_pricing.provider`
  as text, consistent with `1355_expand_runtime_billing_identity`.
- The release logs select the canonical CLI package from commit
  `c9e2fc09eb254a5d43ea42e08d62b52561472591` for the API, and rootfs verification
  reports CLI **9.380.0**, package version and installed manifest/entrypoint on
  the production build path. The downloaded package reports CLI 9.380.0 and
  Pi runtime 1.47.0; its compiled Auto reader is present. Package SHA-256:
  `1319de8ec1cbcba9c836452f72e6ed341f400b5254124402e56406168b70b241`.
- These are release/build/package facts, **not** a complete serving/rollback
  census, proof of every installed supported client, a fresh job's observed
  package selection, or deployed native-history/R2 restoration.
- iOS TestFlight publishing succeeded, but internal TestFlight availability is
  not evidence that every supported iOS installation has upgraded. The Desktop
  release promotion was skipped in that run.

Before actual PR2 writer activation, verify:

1. Successful PR1 migration and serving API/App, drained pre-PR1 instances, and a
   supported rollback floor containing PR1. Database migrations do not roll back
   with code. After new records, rollback below PR1 needs separately reviewed
   forward recovery.
2. Authoritative complete pricing for every enabled preset, retained legacy
   prices for old/late producers, and no settled-amount conversion.
3. The canonical CLI package chosen by fresh jobs, the actual installed
   CLI/Pi/rootfs path, and all supported client readers, not just a green Runner
   promotion or Web version floor.
4. Authorized nonproduction acceptance of both mixed Auto native-history
   directions, same-family resume and actual R2 history restoration. The old
   retained-reference census does not prove activity, binding or readability.
5. Successful canonical execution and runtime-key usage/reporting with long
   context, immutability across org-preset/account/key changes, old-job late
   reports, and missing-price pending/retry behavior. Do not fabricate business
   records or approved prices to manufacture acceptance.

New Pi OpenRouter launches permanently use generation-5 Chat Completions on
current main. Already captured older dialects retain their readers; the captured
dialect is authoritative. No transport switch is restored by this release.

## Verification boundary

The focused writer/preference suites exercise normal public thread, model
preference and chat-input routes (including personal omission/effort and
unavailable Auto rejection). Core compatibility tests and Pi model protocol
matrix cover both Auto spellings and captured Responses/Chat Completions.
Existing CLI model/chat command tests exercise the retained nullable client
intent/catalog contract. API/core lint and type checks are separate static
checks, not deployed acceptance.

The existing `chat-events-model-routing.test.ts` was also run against this
change and the untouched base `d1cf638f579bc85348057ceadd8701b08b80c12c`:
both initially failed the same 10 of 13 named scenarios. The base itself fails
native Runner claims (`Job not found in queue`), Codex device completion and
Auto launch expectations. The changed branch also exposes expected new-writer
assertion differences; those assertions were updated to canonical selection
and runtime billing without deleting or skipping scenarios. Do not call that
suite green or attribute all failures to production pricing. Its unresolved
native fixture/runtime execution boundary still needs validation in CI.

A real successful canonical Auto execution/settlement/long-context replay,
missing-price pending/retry cycle, installed supported consumers and both
mixed native-history/R2 restore directions are **not** proven by these checks.
Authoritative prices and authorized nonproduction execution are required;
private table seeds, copied rates and fabricated approved business state are
not substitutes. The owner-approved pricing follow-up passed 14 Core tariff
boundary/compatibility cases, 11 public writer/preference cases, 29 Pi protocol
cases and 25 CLI cases. The complete DB migration-consistency suite passed
against a fresh disposable PostgreSQL 18 database. Local replay preserved all
pricing rows byte-for-byte; a conflicting-tariff replay raised and rolled back
without persisting its test change. The existing routing suite still failed
10 of 13 scenarios; it is not green after adding prices either. No full local
Vitest suite or local dev server was run.

## Release 3 remains separate

[#38114](https://github.com/okou-ai/okou/issues/38114) owns justified historical
conversion (including online/archive/R2 history), constraints, legacy
catalog/pricing removal and compatibility retirement. This PR does none of
those and introduces no schema contraction. Constraints must not break
still-serving PR1 writers during migrations-before-API promotion.
