# Batch 021: integration fixtures and billing lifecycles

Refs #37440. `<!-- issue-37440-batch10 -->`

## Opening and completion gate

Opening main: `b48cdb3d1745971ce2fd0f70fbb7791eb74f0938`.
Opening balance: 44 helpers (25 shared / 19 local / 0 benchmark) and 15 HTTP
operations / 12 paths / 93 original nested actions. Cumulative merged credit:
200 original identities = 169 helpers (146 retired / 23 public rewrites) + 31
operations. Batch 020 is already accounted for once.

The ten decisions below were recorded in ledger page013 before their respective
implementation, including the explicit withdrawal of Telegram before SSH was
selected. All ten implementations are now present for review: four local helpers
(one retirement, three public rewrites) and six retired HTTP operations on three
paths, including the SSH operation's two nested actions. This is **not a merge
receipt**. No balance changes before actual protected merge. Partial, upstream
and withdrawn candidates receive zero credit.

Decision ledger: <https://github.com/okou-ai/okou/issues/37440#issuecomment-6079232738>.
Current review/CI continuation: <https://github.com/okou-ai/okou/issues/37440#issuecomment-6080302023>.
The previous page012 is preserved with a forward link; no prior decision, failure
or count was truncated.

## Ten original identities and caller decisions

Paths in the helper rows are relative to `turbo/apps/api/src/`. A moved helper
keeps its original file identity. Transport wrappers, actions, cleanup support,
service files and cases count zero additional identities.

| ID  | Frozen original identity                                                                         | Complete caller scope and value                                                                                                                                                                                                                                                                                                                                   | Decision and normal lifecycle                                                                                                                                                                                                                                                                                                            | Boundaries to remove or explicitly retain                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `signals/routes/__tests__/billing-checkout.test.ts::seedLegacyMigrationFixture`                  | Moved by #37940 to `billing-usage-pack-subscriptions.test.ts`; legacy Plan migration availability, preview, payment, cancellation, replay and preservation of existing credit. Follow `previewMigration`, `mockMigrationStripe`, `clearMigrationFixture`, and every direct invocation.                                                                            | Rewritten through normal Plan checkout, server-created Stripe customer/subscription metadata, genuine subscription/invoice callbacks, migration APIs, and public billing/credit views; unique owners and normal workspace deletion.                                                                                                      | No arbitrary org balance/expiry or synthetic legacy grant. Preserve independently constructible migration/payment stages. An unavailable legacy-only premise is not grounds to delete the entire migration scenario.                                                                                            |
| H2  | `signals/routes/__tests__/billing-checkout.test.ts::seedManagedUsagePack`                        | Moved to `billing-usage-pack-subscriptions.test.ts`; direct upgrade, downgrade, member-removal and invitation callers; closures/default arguments in `setupInvitationPreviewContext` and `beginInvitationPurchase`; H3 below.                                                                                                                                     | Retired; all callers now use existing usage-pack checkout, capture the actual outbound subscription identity, invoice callback, management and per-member credit reads, and public cleanup.                                                                                                                                              | Remove synthetic deletion of refund-source records and arbitrary grant mutations only after separating the ordinary member/invitation lifecycle. No credit for merely replacing the constructor while retaining private reads.                                                                                  |
| H3  | `signals/routes/__tests__/billing-checkout.test.ts::confirmPendingUsagePackUpgrade`              | Moved to `billing-usage-pack-subscriptions.test.ts`; four invoice-vs-deletion/refund/replay cases. Financial once-only behavior is valuable.                                                                                                                                                                                                                      | Rewritten: public H2 purchase; known member identity or management response; preview/confirm; real Stripe event shapes; public grant snapshots and provider refund requests; public cleanup.                                                                                                                                             | Internal change-row status and fulfillment-table inspection are not public guarantees. Keep actual credits and refund amount/count/idempotency assertions.                                                                                                                                                      |
| H4  | `signals/routes/__tests__/usage-pack-subscription-lifecycle.test.ts::checkoutUsagePackLifecycle` | 24 declarations / 30 executions call this constructor; the file retains 25 declarations / 34 executions, including parameterized initial/renewal invoices, invitations, Atom credits, duplicate purchases, cancellation, expiry and invalid provider responses; includes its checkout callback and teardown closure.                                              | Rewritten with normal onboarding and usage-pack checkout; capture server-created metadata; invoice/subscription callbacks; public management, billing status and per-member credits.                                                                                                                                                     | Arbitrary negative balances now come from ordinary priced SEO consumption; historical grant injections were replaced by real purchase/reward/provider lifecycles. Do not delete independent payment, replay, cancellation or refund stages to eliminate a private subassertion.                                 |
| A1  | `POST /api/test/discord-state`                                                                   | `helpers/discord.ts::seedDiscordFixture` -> `helpers/discord-fixture.ts::setupConnectedDiscordActor`; integrations-discord, discord-ingress, discord-lifecycle, discord-interactions-preferences, integrations-discord-files/native, internal-callbacks-discord and discord-chat-write-compatibility suites; endpoint selftests embedded in integrations-discord. | Retired unreachable installed-binding construction after per-case assessment. Current normal Discord routes provide status/disconnect/DM selection, but no installation/connection writer; both inserts are in this test route. Permanent DB scripts are not a user writer.                                                              | Keep independent authentication, feature-off, malformed-input, signature, unbound-sender and provider acknowledgement behavior. Remove installed-only guild/DM/history/file/Runner assertions whose premise is manufactured; the exact removed cases are enumerated below. Production Discord behavior remains. |
| A2  | `DELETE /api/test/discord-state`                                                                 | `deleteDiscordFixture` and every cleanup closure/tracker in A1's caller tree.                                                                                                                                                                                                                                                                                     | Retired with A1 and its unjustified fixture consumers. Any retained real resources use the normal owner/provider lifecycle.                                                                                                                                                                                                              | No replacement business-row cleanup helper; no synthetic default Agent deletion.                                                                                                                                                                                                                                |
| A3  | `POST /api/test/slack-state`                                                                     | `helpers/slack-connect.ts`, `helpers/integrations-slack.ts`; slack-oauth, org-delete-billing, run-lifecycle; endpoint selftests.                                                                                                                                                                                                                                  | Existing OAuth install/connect and normal onboarding/default Agent APIs, with Slack/Clerk provider mocks. Existing `slack-public-install.ts` is the starting public implementation.                                                                                                                                                      | Retire endpoint-only diagnostics/provisioning selftests. Preserve ordinary OAuth, membership, source auth, installation and Run outcomes.                                                                                                                                                                       |
| A4  | `GET /api/test/slack-state`                                                                      | The above helpers plus `createBddIntegrationApi.readSlackTestState`; slack-oauth, org-delete-billing and integrations.bdd retry/admission/uninstall/revocation cases.                                                                                                                                                                                             | Observe normal Slack integration status, public Thread events/Run logs and provider-visible effects.                                                                                                                                                                                                                                     | Lose raw ingress attempt/status/retry timestamp, connection row count and internal pending-row inspection where no public equivalent exists. Preserve independent delivery/backoff/replay behavior without longer waits or worker kicks.                                                                        |
| A5  | `DELETE /api/test/slack-state`                                                                   | Slack helper teardown; integrations-slack-status; slack-oauth; run-lifecycle; BDD admission-conflict cleanup and selftests.                                                                                                                                                                                                                                       | Normal signed Slack uninstall/token-revocation event or user uninstall, scoped to real OAuth installation.                                                                                                                                                                                                                               | Do not retain a synthetic cross-workspace globally duplicated event-id race solely to test private cleanup. Keep normal replay and owner isolation stages.                                                                                                                                                      |
| A6  | `POST /api/test/ssh-connection-state/action`                                                     | Ten actual declarations / 27 expanded executions across ssh-access, runner-ssh and runner-vnc; cloudflare-access retains only a dead type-linked factory. Both create-runtime and set-learned-host-key actions are included.                                                                                                                                      | Preserve host defaults/overrides, two-Thread isolation, concurrent host creation, wrong official process/foreign owner, pending and three terminal states through normal Plan/model authorization, Thread launch, actual heartbeat/claim credentials, authenticated Runner callbacks, owner configuration and normal workspace deletion. | Retire synthetic running/no-chat and running/unclaimed matrices, eight hand-set channel-enum origins and corruption-only ssh-dss/invalid stored-key case. Real malformed pin rejection stays. Separate valid public phases from removed private subassertions.                                                  |

## Candidate exclusions and inventory reconciliation (zero credit)

- Canonical Agent reader / `preparePiResourceHandoff`: removing the forced pending
  instruction injection alone leaves actual retained Auto callers on private
  built-in key setup. They are not selected or complete. The handoff four-prompt
  matrix and Pi memory direct caller also remain untouched.
- Social data `pricing` / `seedActor`: the source has no default `monid/*`
  pricing in existing migrations/dev-seed. Do not move these business aliases
  into global seed, change billable results to zero, or delete core financial
  assertions to manufacture completion.
- Seven frozen identities have already been removed by other upstream PRs but
  have not been debited in the 001–020 manifests: AgentPhone legacy route (#38119,
  `8418b0d73d57b2e6f2d18234e262f9527ed9e006`); four old Official queue identities
  (#38049, `76c17bcc4048d9aff4907477012172c364a66e5c`); legacy Connector catalog
  payload (#38099, `9d3a1b406f1f44b224c33046162df01a77e035f8`); legacy Runner
  context (#38066, `865afb7a05d413c9db56713035a373ebaa767672`). They are inventory
  reconciliation evidence, zero batch021 quota and no silent opening-balance
  change.
- Original async `billing-checkout::trackedSeed` maps to
  `billing-checkout-complete.test.ts:299`, not the current same-name pure-ID
  helper. Its private pending branch was collateral cleanup in batch012;
  unchanged review does not qualify it for this batch.

## Unprocessed boundaries

Storage fixture transport; fabricated limited-free bootstrap/Run token;
built-in exact two-token/H2 and pricing/key factories; global pricing seeds;
System cache/Run/Pi/memory/projection/usage/pricing/connector/export chains;
service/import exceptions; Image default-price 503; and the fully restored ten
Unread cases (100/101/128 threads, every terminal/cursor, exact notifications,
5000ms) remain unresolved. No adjacent factory is certified by selected methods.

Historical failures, cancellations, audit ignored-high findings, batch019's
failed resource cleanup and batch020's distinct successful cleanup remain in
their immutable manifests and ledger. #37440 remains OPEN; #33778 remains
superseded, not completed. Identity-inventory completion is not whole-scope
completion.

## Implementation decisions and exact coverage boundaries

### H1: legacy Plan migration

The original helper moved in #37940 (`41efedd7b004474b43285c3ccb23d37a1041386f`);
its frozen identity remains in `billing-checkout.test.ts`. All 13 declarations /
15 parameter executions remain. The old helper inserted a subscription, arbitrary
12,345-credit grant and expiry. The new helper calls ordinary Plan checkout,
captures server-created subscription/customer metadata, and delivers the Stripe
subscription/invoice protocol. Real Pro/Team grants are 20,000/120,000. Public
billing, active-member management and credit-grant snapshots replace private row
reads. Normal workspace deletion replaces business-row cleanup.

Migration availability, preview rejection when items change, legacy cancellation,
scheduled Pro-to-Team transition, first paid/zero invoice, invitation acceptance
and revoke/refund, duplicate callbacks, and concurrent invoice handling remain.
The accepted-member stage is independently delivered through Clerk before expecting
two active allocations; pending invitations are not invented as public members.
SEO consumption constructs a real -5,000 wallet debt where needed. Grant ID,
amount, remaining value and expiry snapshots preserve existing-credit assertions.
Lost guarantees: arbitrary 12,345/expiry combinations, private failed-reason/change
status, raw fulfillment counts, and pending allocation rows.

### H2/H3: managed packs, upgrades, invitations and refunds

`seedManagedUsagePack` is retired. Its 11 declarations / 12 executions (including
H3's four cases, counted once) become 10 / 11 after removing one overlapping paid
upgrade declaration. All retained chains use the existing normal checkout and
captured subscription ID, actual invoice callback, public management/member-credit
views, and normal workspace deletion. `confirmPendingUsagePackUpgrade` is publicly
rewritten, keeping all four invoice-versus-deletion cases: exact 1,500 refund,
provider request count and idempotency, 20,000+400 to 35,000+1,500 grants, and replay.

The retained eight-concurrent-delivery upgrade case also asserts the exact preview
`proration_date`, `pending_if_incomplete`, `always_invoice`, provider idempotency
key, one update across repeated confirm, four exact grants, and replay unchanged.
It subsumes the removed two-delivery case's public guarantees. Its private inactive
allocation/refund-source/change/fulfillment row assertions are intentionally lost.

Deferred payment (20/0), scheduled downgrade, last-member refund, no refundable
amount, fully discounted invitation, and partial-consumption refund remain. The
partial invitation now confirms the ordinary purchase using a saved card, captures
the outbound invoice metadata, accepts the real invitation, and consumes 5,000
credits through ordinary SEO pricing. It preserves remaining 5,000 and the failed
then successful 500 refund, two distinct retry idempotency keys and no third refund
across three Clerk deletions. This is no longer a synthetic PaymentIntent-only
setup or an erased refund-source fallback test. Raw refund/change/fulfillment row
states and arbitrary grant mutations are lost; actual amounts and provider effects
remain. Other private usage-pack fixture callers outside these three identities
remain unprocessed and get no certification.

### H4: subscription lifecycle

All 25 declarations / 34 parameter executions in this file remain; H4 is reached
by 24 / 30, while the four-row Atom visibility case is not a new identity. The
constructor and its closure now use public checkout, server metadata, provider
callbacks, public billing/active-member/grant reads and workspace deletion.

Negative debt comes from a real check-in credit followed by an ordinary priced SEO
request: observed starting balance + 100 - desired negative balance determines the
provider cost using the existing migration1078 tariff. Paid member grants are not
modified. Positive first-upgrade history uses the real 2,000-credit Slack OAuth
reward, replacing the arbitrary 5,000 row; the two-row matrix remains [0, 2,000],
not the old [0, 5,000]. Normal credit checkout, auto-recharge, legacy Plan invoices,
calendar expiry and ZERO100 redemption construct prior-history branches. The
legacy expiry case fixes application time to 2035-05-15 so the Apr15 period's
one-calendar-month grant is actually expired; no wait or timeout was added.

Preserved guarantees include 16,670+866 proration, exact grant cardinality/amount/
expiry, renewal and replay, initial-debt waiver once, invalid provider data failure
then correction, rollback after oversized provider data, cancellation and delayed
invoice behavior, duplicate purchase winner/refund, personal 1,000 to 21,400,
zero-price non-refundable membership removal, and all original Atom callback
amounts. Genuine zero-price Atom Stripe protocol mocks were already the external
input in this suite; they do not prove a real Atom producer or payment. Provider
metadata and current public billing replace private subscription start/status rows.
Lost guarantees: raw fulfillment/refund/change records, inactive/pending allocation
rows, private subscription start/period-null fields, arbitrary grant/expiry seeds.

### A1/A2: Discord binding fixture retirement

Source tracing finds both connection and workspace-binding inserts only in the
removed test route; ordinary production routes expose status, disconnect, DM
selection and execution, without an installation writer. Operator DB scripts are
not ordinary user setup. Installed guild/DM/history/attachment/Runner tests thus
manufactured a premise the normal product cannot construct. Retire those scenarios
and their unsupported fixture/cleanup rather than adding a test-only product API.

Across affected Discord files, 135 declarations / 207 executions become 12 / 21:
123 declarations / 186 executions retire. Six retained declarations / eight
executions are rewritten; six / thirteen independent declarations remain. The
retained file-auth/capability checks use actual claim-issued credentials. Feature
rejection, unbound 404, malformed upload's eight rows, malformed download, signed
provider acknowledgement, unbound guild ignore and hourly disconnected-DM notice
remain. The three-row ignored-message matrix now uses unbound workspaces in every
row. It no longer certifies installed-unmentioned chatter or a configured disabled
binding. Existing interaction signature/PING suites remain unchanged.

Lost installed-only guarantees include guild/DM mapping and channel selection,
preferences, lifecycle disconnect, history/attachment/callback forwarding,
capability behavior on an installed binding and the DB endpoint's self-assertions.
No production Discord handler, token verifier, feature default, table or worker is
removed. The complete retired declaration list below is authoritative.

### A3/A4/A5: Slack OAuth and provider lifecycle

Normal OAuth replaces connection/key provisioning; signed `app_uninstalled` or
ordinary user uninstall replaces test-row cleanup. All 42 OAuth declarations and
10 integration-status declarations remain. Reinstall checks use actual OAuth,
public connection/workspace/scopes, the centralized external Slack client
constructor mock's refreshed credential, and provider welcome output. Duplicate
installation preserves exactly one 2,000 reward, 168-hour expiry and expiry
exclusion; it no longer counts physical connection rows.

The provider-backoff scenario retains five visible attempts and production
60s/300s/1800s/7200s delays using controlled application time, the first +1ms early
rejection, terminal five-attempt ceiling, +24h no extra attempt and empty public Run
logs. Private ingress status/retryAt/errorClass observations are removed; later
boundaries are not claimed as individually checked early. Uninstall/revocation
remains observable through public integration status and provider responses.
The org-deletion refund-failure test retains Stripe cancellation once, HTTP500,
no Clerk deletion and preserved preferences/integration, but loses the fabricated
Runner membership-cache observation.

Retire 17 endpoint selftests, one synthetic globally duplicated event-ID admission
race across workspaces, and one built-in Auto case driven by releasing a shared
fixture key: 19 declarations / 19 executions. Slack event IDs are provider-global;
normal replay is still covered. `cli-auth.service.ts` loses only test identity/org
resolution helpers whose sole consumer was the deleted Slack POST route;
production `issueCliToken$` stays. This orphan cleanup has zero quota.

### A6: real claimed SSH/VNC Run lifecycles

The operation's two actions (`create-runtime`, `set-learned-host-key`) and all
transport/fixture/type closures are gone. Ten actual declarations / 27 expanded
executions become six / six. Four declarations / 21 executions retire. Dead
Cloudflare fixture support is also removed; its 29 cases remain unchanged.

Normal Plan/model authorization, Agent/Thread launch, heartbeat and claim supply
actual Runner credentials. Two Threads, current host defaults/overrides,
concurrent host creation, wrong official process/foreign owner, pending and all
three actual terminal states retain their public inventory/resolve/pin checks and
no-credential-decryption assertions. Cleanup cancels and ACKs actual Runs, deletes
the owning Agent before its workspace, and uses ordinary organization deletion.

Retired: the 3-row user no-chat matrix, the 16-row Runner no-chat source matrix,
one corruption-only stored ssh-dss/invalid-key case, and one case looping eight
manually set channel enums. Inside retained tests, running-unclaimed and fabricated
no-chat subphases are removed; these are not equivalent to normal pending/terminal
states. The public malformed-key pin rejection is still tested. Independent
capability-only tests not using this operation are not certified by these changes.

## Scope, verification and accounting gate

Only proven test controls/routes/contracts, their orphan support and transaction
lint baseline entries are removed. Ordinary product routes, defaults, accounting,
workers, locks, constraints and migrations are unchanged. No workflow/CI policy,
retry, timeout, assertion threshold, deployment or protection change. External
Stripe/Slack/SEO/S3 mocks model provider requests/responses: they do not prove real
payment, a Runner process, or S3 HTTP PUT. Real production HTTP routes execute in
the test harness; selected history completion supplies SHA-matching bytes only for
the actual prepare-authorized S3 key. Actors are unique on shared PostgreSQL, not
per-case independent databases. Public deletion/cancellation is not a claim that
immutable receipts or every unrelated fixture row are erased.

Bounded independent read-only preflight found and corrected active-versus-pending
member observations, a PaymentIntent-only invitation construction, legacy calendar
expiry and orphan CLI helpers. Final committed-HEAD review and GitHub behavior CI
remain required. No local Vitest or dev server was run.

Observed local validation so far: API full type checks passed after dependency
builds; final scoped oxlint, type-aware oxlint, ESLint and Knip passed. Final API full types also passed after the last substantive code edits. Initial final-tree formatting failed on ten files and was corrected with Prettier; no behavior changes. The checkout has no installed commit hooks; equivalent applicable checks were explicitly executed without any bypass flag. Retain failures:
initial TS6305 dependency declarations (fixed by proper build), Slack return/Discord
nullable type errors (fixed), wrong @okouai/api filter matching zero projects
(not a pass), initial lint/style/duplicate-hook and unused exports (fixed), and one
full API lint process exit137 without proven root cause. It is not called a flake.
Final exact commands/results and all GitHub failures belong in the append-only
ledger; passing follow-ups do not erase these observations.

Potential post-merge balance, **not yet debited**: 40 helpers (25 shared / 15 local)

- 9 operations / 9 paths / 91 original actions. Cumulative 210 identities = 173
  helpers (147 retired / 26 public rewrites) + 37 operations. Only exact-HEAD review,
  required PR CI, protected merge queue and actual MERGED authorize that one debit.

## Case accounting

Parameterized declarations count once; expanded rows are reported separately.
Net retirement is **147 declarations / 227 parameter executions**: Discord
123/186, Slack19/19, SSH4/21, overlapping billing1/1. The selected financial helper
union is 48/57 before, 47/56 after (H3 overlaps H2). H4 retains its entire25/34.
SSH's six retained declarations/six executions are rewritten. OAuth/status cases
also share rewritten install/cleanup; do not add every helper caller to a second
case total. Internal loops are disclosed above, not counted as parameter rows.

The following per-file table includes unchanged adjacent cases to make deletions
reconcilable; these adjacent cases get no cleanup certification. One unchanged
Run-lifecycle matrix has nonliteral rows, marked U; its contribution cancels in
the exact net delta.

### Candidate correction before SSH implementation

The Telegram operation is withdrawn with zero credit: its retained callback error matrix still reaches the private built-in model/key setup. All attempted Telegram edits were restored; no Telegram completion is claimed. A6 above replaces it after complete read-only caller review. SSH pending and terminal behavior must remain; synthetic no-chat provenance is not equivalent to terminal Thread deletion.

| File                                        | Before declarations/executions | After declarations/executions |
| ------------------------------------------- | ------------------------------ | ----------------------------- |
| `billing-usage-pack-subscriptions.test.ts`  | 108/120                        | 107/119                       |
| `cloudflare-access.test.ts`                 | 29/31                          | 29/31                         |
| `discord-chat-write-compatibility.test.ts`  | 1/1                            | 0/0                           |
| `discord-ingress.test.ts`                   | 22/39                          | 3/5                           |
| `discord-interactions-preferences.test.ts`  | 10/15                          | 0/0                           |
| `discord-lifecycle.test.ts`                 | 1/1                            | 0/0                           |
| `integrations-discord-files.test.ts`        | 28/40                          | 6/13                          |
| `integrations-discord-native.test.ts`       | 30/53                          | 1/1                           |
| `integrations-discord.test.ts`              | 22/31                          | 2/2                           |
| `integrations-slack-status.test.ts`         | 10/10                          | 10/10                         |
| `integrations.bdd.test.ts`                  | 46/49                          | 45/48                         |
| `internal-callbacks-discord.test.ts`        | 21/27                          | 0/0                           |
| `org-delete-billing.test.ts`                | 15/22                          | 15/22                         |
| `run-lifecycle.bdd.cases.ts`                | 149/162+U                      | 148/161+U                     |
| `runner-ssh.test.ts`                        | 26/42                          | 23/24                         |
| `runner-vnc.test.ts`                        | 25/26                          | 25/26                         |
| `slack-oauth.test.ts`                       | 42/43                          | 42/43                         |
| `ssh-access.test.ts`                        | 8/10                           | 7/7                           |
| `test-slack-state.test.ts`                  | 17/17                          | 0/0                           |
| `usage-pack-subscription-lifecycle.test.ts` | 25/34                          | 25/34                         |

### Retired declarations (exact titles)

Renamed retained declarations are excluded from this list. Numeric suffixes are
expanded parameter rows; one row is one ordinary execution.

`billing-usage-pack-subscriptions.test.ts`:

- applies a paid upgrade once with the preview proration date — 1 execution(s).

`discord-chat-write-compatibility.test.ts`:

- posts the Discord reply once when the runner repeats its terminal callback — 1 execution(s).

`discord-ingress.test.ts`:

- copies the Chat browser preference (%s) into new threads without changing existing routes — 2 execution(s).
- creates one owned input and run across concurrent relay retries — 1 execution(s).
- tells a Discord run how its final reply and files reach Discord (private artifacts %s) — 2 execution(s).
- requires %s public-thread creation permission even when the other party is an administrator — 2 execution(s).
- applies public-thread creation authority: $name — 13 execution(s).
- keeps two users in one physical Discord thread in separate owned chats — 1 execution(s).
- ignores temporary guild unavailability and deduplicates uninstall replay after reinstall — 1 execution(s).
- does not launch an accepted message again after disconnect and reinstall — 1 execution(s).
- pins guild and DM models when each thread is created — 1 execution(s).
- keeps the same DM thread when its connected sender moves to a new physical channel — 1 execution(s).
- updates the main DM thread model without changing the member default — 1 execution(s).
- pins a busy main DM and captures a web send model before the next pick — 1 execution(s).
- keeps another organization's DM replies out of a newly selected organization's run — 1 execution(s).
- requires explicit DM org choice and keeps a replay bound to its original org — 1 execution(s).
- asks a DM sender with several workspaces to choose one with /okou org — 1 execution(s).
- sends no DM notice while the feature is off for the sender's workspace — 1 execution(s).
- imports refreshed attachment metadata while keeping context and signed URLs private — 1 execution(s).
- tells the Discord thread when the org is at its concurrent run limit and starts it once a slot frees up — 1 execution(s).
- suppresses input and delivery when the sender disconnects during context import — 1 execution(s).

`discord-interactions-preferences.test.ts`:

- does not disconnect a configured account while the feature is disabled — 1 execution(s).
- disconnects only the invoked workspace and exposes that change through status — 1 execution(s).
- requires and saves an explicit workspace choice for a sender with multiple DM bindings — 1 execution(s).
- preselects the effective model and the selected DM workspace — 1 execution(s).
- switches the routed server thread the model picker runs in — 1 execution(s).
- switches the routed server thread to canonical Auto — 1 execution(s).
- rechecks personal subscription access after a picker is issued without changing the member preference — 1 execution(s).
- rejects a signed control with changed %s context — 3 execution(s).
- applies no selection when Discord's acknowledgement is uncertain — 1 execution(s).
- rejects a model selection revoked by %s during access revalidation — 4 execution(s).

`discord-lifecycle.test.ts`:

- removes a departed member's binding only in the affected organization — 1 execution(s).

`integrations-discord-files.test.ts`:

- requires the %s to have ATTACH_FILES in addition to readable channel access — 2 execution(s).
- denies bot DM attachment downloads while keeping uploads to the sender's own DM — 1 execution(s).
- returns fresh, authorized attachment bytes with private download headers — 1 execution(s).
- does not download a forged attachment ID from an otherwise readable message — 1 execution(s).
- refreshes an expired CDN URL once from the same message identity — 1 execution(s).
- stops after the refreshed attachment URL is still unavailable — 1 execution(s).
- rechecks the live feature gate before refreshing an expired attachment — 1 execution(s).
- rejects an unsafe CDN %s without requesting another origin — 3 execution(s).
- rejects streamed bytes beyond the Discord file limit without a length header — 1 execution(s).
- rejects an unsupported or mismatched CDN MIME type %s — 2 execution(s).
- does not expose another %s's asset through materialize or complete — 2 execution(s).
- rechecks the live feature gate before delivering a published file — 1 execution(s).
- publishes one canonical artifact before delivery and reuses its receipt — 1 execution(s).
- rejects reuse of an operation for a different destination or file — 1 execution(s).
- refuses publication when the stored bytes have a different checksum — 1 execution(s).
- does not send a file again after Discord's response is lost — 1 execution(s).
- records the receipt when Discord normalizes the attachment filename — 1 execution(s).
- reports a Discord rate limit without sending again on a later completion — 1 execution(s).
- allows only one external message when completion requests overlap — 1 execution(s).
- does not replay a receipt after its verified connection is removed or replaced — 1 execution(s).
- keeps a Run-owned Discord upload visible in its originating chat thread — 1 execution(s).
- publishes a Discord-origin Run's output to its native thread and canonical artifact list — 1 execution(s).

`integrations-discord-native.test.ts`:

- reads a post in a type %s forum or media channel by its thread ID — 2 execution(s).
- returns attachment metadata without the signed CDN URL — 1 execution(s).
- returns exact snowflake pagination and source links — 1 execution(s).
- marks ordinary guild content as limited — 1 execution(s).
- rechecks provider grants instead of retaining a prior content capability — 1 execution(s).
- fails guild history closed on application discovery failure %s without blocking sends — 6 execution(s).
- preserves application-discovery rate limits for history callers — 1 execution(s).
- denies bot DM content to every organization's run token while keeping DM sends — 1 execution(s).
- denies %s without exposing message contents — 5 execution(s).
- denies an explicit different guild selector and another organization token — 1 execution(s).
- applies everyone, aggregated role, and member overwrite precedence — 1 execution(s).
- lists only mutually visible readable channels and requires history permission to read — 1 execution(s).
- requires private thread membership for the %s — 2 execution(s).
- conceals %s thread state until both principals have access — 2 execution(s).
- reads a private thread with both memberships and inherits parent overwrites — 1 execution(s).
- reads native thread replies and refuses to treat an ordinary reply as a thread — 1 execution(s).
- revokes native access after disconnect without reusing a previously verified binding — 1 execution(s).
- normalizes %i closing-fence spaces while preserving code within every message limit — 2 execution(s).
- preserves a long fenced answer and suppresses all mention notifications — 1 execution(s).
- sends into an archived unlocked thread, which Discord reopens (private: %s) — 2 execution(s).
- reads a locked thread and sends only when MANAGE_THREADS is held by $name — 7 execution(s).
- denies writes for a timed-out %s while retaining readable history — 2 execution(s).
- keeps native history and existing-thread sends available without public-thread creation permission — 1 execution(s).
- requires SEND_MESSAGES_IN_THREADS rather than parent SEND_MESSAGES — 1 execution(s).
- retries only an explicit short 429 and returns a complete message receipt — 1 execution(s).
- rechecks %s access after a rate limit before resending — 3 execution(s).
- surfaces read rate limits without replaying an authorized content request — 1 execution(s).
- reports a provider rate-limit delay and preserves already-delivered chunks — 1 execution(s).
- surfaces a provider server failure without resending an uncertain write — 1 execution(s).

`integrations-discord.test.ts`:

- lets users remove Discord data after the feature is rolled back — 1 execution(s).
- reports existing bindings and unavailable context when app configuration is missing — 1 execution(s).
- reports verified guild identity and honest MESSAGE_CONTENT availability — 1 execution(s).
- reports full context for Discord's actual grant $flags/$flagsNew — 3 execution(s).
- reports mentions-only when the authoritative flags do not grant content — 2 execution(s).
- does not claim content access from invalid or mismatched application metadata — 4 execution(s).
- reports unavailable context when application discovery fails with %i — 4 execution(s).
- disconnects only the caller while preserving the guild and another verified user — 1 execution(s).
- requires the current admin role for uninstall and removes only that guild — 1 execution(s).
- notifies the uninstalling user, connected users, and cached admins once each — 1 execution(s).
- hides revoked membership and refuses subsequent binding mutations — 1 execution(s).
- requires an explicit DM choice across organizations and invalidates a revoked choice — 1 execution(s).
- rejects DM selections for another Discord sender or another Okou user — 1 execution(s).
- always reports the organization default agent — 1 execution(s).
- is unavailable in production even for an authenticated admin — 1 execution(s).
- requires an authenticated admin in development — 1 execution(s).
- rejects supplied Okou identity fields and conflicting guild ownership — 1 execution(s).
- converges repeated concurrent provisioning on the same verified connection — 1 execution(s).
- allows only one guild to win concurrent installation for an organization — 1 execution(s).
- scopes fixture deletion to the authenticated organization — 1 execution(s).

`integrations.bdd.test.ts`:

- admits a later canonical-route retry after its first ingress insert fails — 1 execution(s).

`internal-callbacks-discord.test.ts`:

- delivers canonical output after a long task to the native thread exactly once — 1 execution(s).
- delivers the canonical safe run error without exposing the internal failure — 1 execution(s).
- delivers cancellation before a runner claims the queued run — 1 execution(s).
- delivers a queued admission failure once for $agent without launching another run — 1 execution(s).
- suppresses a final reply after %s revocation without losing canonical completion — 2 execution(s).
- delivers the final reply after the thread auto-archives during the run — 1 execution(s).
- delivers into a thread locked during the run only for a MANAGE_THREADS $sender — 2 execution(s).
- launches a queued follow-up after the thread auto-archives — 1 execution(s).
- keeps a revoked %s active input queued until the next pick rejects it — 2 execution(s).
- drops previously read history when the current %s is revoked — 2 execution(s).
- does not retry a reply that Discord rate-limits — 1 execution(s).
- sends each part once and stops at the first part Discord does not accept — 1 execution(s).
- does not repeat a lost send whose response never arrived — 1 execution(s).
- shows typing on admission and refreshes it from Runner heartbeats until the reply — 1 execution(s).
- shows typing when a queued Discord follow-up is admitted and when it launches — 1 execution(s).
- delivers the reply when Discord rejects typing with HTTP %s — 2 execution(s).
- waits out a typing rate limit without delaying the reply — 1 execution(s).
- stops typing after %s revocation — 2 execution(s).
- refreshes typing without repeating Discord permission reads inside the reuse window — 1 execution(s).
- stops typing after member revocation once the reuse window ends — 1 execution(s).
- pauses all typing after a rate limit on a Discord permission read — 1 execution(s).

`run-lifecycle.bdd.cases.ts`:

- keeps built-in Auto admission after a Slack fixture releases its shared key — 1 execution(s).

`runner-ssh.test.ts`:

- does not turn a malformed stored host identity into unavailable or decrypt credentials — 1 execution(s).
- treats every chat channel equally — 1 execution(s).
- denies a %s Run without a chat thread despite an enabled host default — 16 execution(s).

`ssh-access.test.ts`:

- denies %s Runs without a chat thread despite an enabled host default — 3 execution(s).

`test-slack-state.test.ts`:

- stays hidden in production before authentication — 1 execution(s).
- requires authentication in an allowed preview — 1 execution(s).
- allows an authenticated organization request in preview — 1 execution(s).
- returns 404 outside allowed test environments — 1 execution(s).
- requires the preview bypass secret in preview — 1 execution(s).
- requires team_id — 1 execution(s).
- returns empty workspace diagnostics for an unknown team — 1 execution(s).
- returns Slack installation diagnostics, recent runs, and default agent metadata — 1 execution(s).
- returns 404 outside allowed test environments — 1 execution(s).
- requires team_id and slack_user_id — 1 execution(s).
- seeds a Slack installation without optional state — 1 execution(s).
- optionally seeds a Slack connection — 1 execution(s).
- optionally seeds the default Slack agent — 1 execution(s).
- is idempotent for existing installations, connections, and default agents — 1 execution(s).
- returns 404 outside allowed test environments — 1 execution(s).
- requires team_id — 1 execution(s).
- clears API-visible default Slack agent state after delete — 1 execution(s).

## Evidenced main integration

GitHub reported CONFLICTING against main `03c79d9a11fa49dab3f4ddf755a969452a82fe2d`. The branch merged that main once. Upstream removed the DELETE Discord fixture transaction (TX-0017), while this batch removes the complete fixture operation. Resolution retains operation deletion and both branches' baseline removals, including upstream TX-0103/TX-0251. Upstream production transaction cleanup is not batch021 credit. No speculative main update. The stale preview-only comment beside normal Slack OAuth registration was also removed after independent review identified it as orphan text.

## Final-review whole-chain correction

Independent review of source34147cc3 found the retained Slack App Home/welcome/lifecycle GET caller still reached the fabricated-Run bootstrap through `bootstrapLimitedFreeOnboarding`. It now calls ordinary Clerk-authenticated onboarding status and complete, followed by normal workspace deletion. All Home, welcome-once, disconnect, uninstall and revocation assertions remain. The old displayName option was already ignored by that bootstrap and is not a lost outcome. Other unselected bootstrap callers remain unresolved. This repair adds zero quota and removes no case or parameter row.

## First behavioral CI failure and narrow repair

Source `afe8290c4cc104e646ef5b10b0b9258457617c30`, Turbo37926798890/API8 job113808227462: seven failed,706passed. Cancelled API4 job113808227368 nevertheless finished its test step: nine failed,599passed; API2 job113808227399 recorded one failed Discord native case before cancellation. API1/API5 test steps757/757 and578/578 passed but their jobs are CANCELLED, not green. The source ended81success/28skip/4cancel/2failure. All raw failure evidence is retained in page014; no blind rerun.

Repairs preserve all declarations, parameter rows, exact financial outcomes and time limits:

- Invitation acceptance legitimately grants the inviter100 bonus. Assert five precise grants: the original two unchanged by ID, one owner100 bonus, accepted member20,000+400; repeated acceptance leaves the full snapshot unchanged. This corrects the attempted four-row public expectation, not a production reward change.
- Stripe checkout orders known pack amounts20/50/100/200; the constructor now expects that exact order and quantities rather than insertion order50/20. Cancellation asserts the actual free active entitlement plus canceled subscription/no subscription, preserving exact unchanged grants and no refunds; entitlement status is not subscription status.
- A real refund source has an invoice line: assert its2,000 amount in the precise invoice-line credit-note shape and retain2,000 refund/idempotency. Purchased grants are consumed before bonus in production. The partial invitation spends5,000, keeps purchased5,000 and bonus200, then still refunds500 with the same two attempts and replay guards. The two grants are compared by grantType, never random UUID order.
- Public billing status for Team/Custom reads the configured concurrency Price. Its external Stripe mock now returns a valid active recurring positive USD price; no business price seed or product logic changes.
- Prior-cash setup delivers the existing Stripe created then updated lifecycle: created binds the subscription, updated activates the Plan. Public pro/canBuyCredits/credits0 is asserted before cash purchase. No Plan invoice, paid-Plan credit grant or lastProcessedInvoiceId is added, preserving the prior-cash-specific premise.
- Both retained Discord real-claim callers now acknowledge normal Agent storage initialization through the existing S3 mock before create/claim. No fabricated token, internal state insertion or real HTTP PUT claim.

Local/static checks and new-head PR CI must verify these repairs. These source-level explanations are not claims that the rerun has already passed.

## Second behavioral CI failure and complete lifecycle repair

Source `09699bea5e169ffe0f01cae259bd582c562860d4`, Turbo37928412359/API4 job113813049528 failed seven cases (587 passed): six H4 billing status reads still rejected `price_bdd_concurrency`, and the retained Discord files claim still lacked member memory. Cancelled API2 job113813049347 completed its test step with one failed/666 passed, the Discord native memory case. Cancelled API1/API3 test steps passed761/761 and951/951; cancellation is not a green job. API5/7/8 passed as jobs. No unchanged retry was requested. Security audit job113812954856 still reported one high (one ignored), with no vulnerability-fix credit.

The first attempted fixes were incomplete, not flaky failures. `optionalEnv()` reads a separate raw override map and process environment; the production concurrency selector reads parsed `env("OKOU_PRICE_CONCURRENCY")?.[0]`. The external Stripe catalog now reads that same configured first Price ID. Merely acknowledging S3 writes cannot create member memory: the ordinary onboarding-complete route calls `initializeMemberMemory$`, while Agent creation does not. Both retained Discord claims now complete onboarding through its normal authenticated route before launch/claim. No test case, parameter row, assertion or time budget is removed or relaxed.

The cancelled API2 log also contains a real selected-case `StoragePrefixPurge` warning: `external-setup.ts` resets provider mocks in afterEach before onTestFinished performs Agent deletion, leaving ListObjects undefined. The two Discord claims now use the existing durable external S3 mock scoped to their organization prefix, with only API-written object bytes, and restore that same captured transport for normal cancel/ACK/Agent cleanup. Normal workspace deletion is registered before Plan/claim cleanup, so it executes after them while the owner is still available for Agent deletion. The final workspace helper uses an empty provider listing: it does not prove every remote byte was purged. Member memory is a normal empty initial version and does not require a PUT. No S3 seedObject, business-row seed, fabricated token or private worker call is introduced. This does not claim a real Runner process, payment or S3 HTTP PUT, nor establish that historical remote resources were recovered. New-head independent review and PR CI remain required.

## User-requested main update after the Runner E2E failure

Ethan explicitly requested merging current main and checking the updated PR. Main `6ea7ed14c1b88377c38dfd3bd6b08cc94dd67b15` merged without conflicts into source `97e75b4e48a029582f05762f2511702128a53400`. This is an authorized branch update, not a demonstrated fix for the earlier failure. Turbo37929645532/job113818645236 failed the Auto successor context observation after its existing 30-second bound; the producer/query root cause remains unverified, and the full log and unsuccessful provider diagnostics remain in page014. The eight API jobs passed on that source. No unchanged-job retry, context assertion change or timeout increase was made.

Both automatic test-file merges retain the cleanup and upstream behavior: the billing file gains the upstream late-invitation refund/replay case from #38457, while the unselected limited-free lifecycle case adopts #38389's canonical `"auto"` catalog identity. Those upstream cases, model/schema migration, Storage changes, connector work and transaction removals receive no batch021 credit. The selected ten identities, 147 retired declarations/227 expanded executions, financial-helper union47/56 and complete lifecycle file25/34 are unchanged. A new independent current-HEAD review and all required CI are necessary before protected queue admission; no debit occurs before actual merge.

## Queue conflict after upstream session-history protocol migration

Source `03c9fe63aaacb1779adb2f6c79c9b38c3e21b6b3` received full independent LGTM6081568533 and passed all eight API jobs/four required gates (87 success/28 skipped at queue admission). The formerly failing Auto successor-context case passed in13,705ms without changing its context assertion or30-second bound; the old failure remains unexplained. The protected queue admitted this reviewed source at2026-10-09T13:12:26Z, then marked it UNMERGEABLE behind #38399. After #38399 merged, GitHub removed this PR from the queue and reported CONFLICTING/DIRTY. No batch021 merge-group workflow was created, and no failed or discarded group was rerun.

The required integration with main `0c926e34ca09edaf2840ffcbfa56f3dc07a4588d` has one modify/delete conflict: `internal-callbacks-discord.test.ts`. Upstream only renames its session-history prepare helper and webhook payload from `checkpoint` to `completion`; this batch already retires the complete installed-Discord suite for its documented private construction. Resolution retains that reviewed deletion, without deleting another case or suppressing an assertion. Automatic merges retain upstream's authenticated session-history prepare/completion protocol in the surviving remote-access, Slack and Run lifecycle callers and remove obsolete contract exports. Upstream protocol, persistence and release changes receive no batch credit. The ten identities and coverage accounting remain unchanged; this new source again requires independent current-HEAD review, source CI and protected queue verification before any debit.
