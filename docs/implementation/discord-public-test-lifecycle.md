# Discord public test lifecycle migration

Scope: the existing Discord API suites on base
`e8b57cf4a83fc0195e46a2bf9e3c78a6802a3d1e`, integrated by the #36636 PMO into
PR #37968. This work does not implement OAuth product code or the parent-owned
new parity cases.

## Construction and retirement

- `helpers/discord.ts` constructs bindings through one uniform public lifecycle:
  authenticated OAuth start returns state in its authorization URL and a separate
  completion token; provider callback redirects to the configured App's approval
  fragment; the authenticated consent browser approves using the callback-issued
  approval proof; the original authenticated opener completes using only its
  start-issued completion token; integration status provides connection IDs.
  Proofs stay in function-local memory, are never logged, and have no cookie
  fallback. Discord IDs are external provider context, never binding proof.
  Install and connect are explicit choices.
- Teardown calls production disconnect; installer-owned fixtures additionally
  call production uninstall, without elevating a member to admin.
- OAuth provider handlers have a finite exchange lifetime and fall through for
  other identities and subsequent native bot traffic. Token/grant/Bearer-user
  responses are one-use for their exact code/token; unrelated Bot requests do not
  consume them. Live Bot/member checks remain available for final revalidation
  and welcome delivery, then deactivate in `finally`. Central MSW cleanup owns
  registration reset. Real database isolation remains owned by `testContext`.
- Ordinary native calls use real sessions or PATs issued through device authorization. Cases
  needing Run identity use a real chat admission and authenticated Runner claim.
  Capability absence is constructed by issuing a Run while the feature is off,
  then enabling it before the attempted native call. Sandbox authorization uses
  the Runner-issued sandbox token.
- Clerk identity and membership mocks, including `seedOrgMembership$`, remain
  external-provider infrastructure. They are not application business seeds.
- No preview helper names, preview-contract imports, preview route imports, or
  preview history parameter remain in these helpers or suites. Parent owns
  deletion of the production preview route, contract, registry entry, and its
  separate deployment/documentation changes.

## Exact scenario decisions

| File and exact declaration                                                                                                                          | Construction dependency                                                                                                                                                       | Decision                   | Coverage lost or retained                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations-discord.test.ts`: `is unavailable in production even for an authenticated admin`                                                      | Preview provision/delete endpoint and preview-only deployment gate                                                                                                            | Delete                     | Loses the retired endpoint's production gate assertion. No tombstone test or replacement claimed.                                                                                                                                                                                                                                                       |
| `integrations-discord.test.ts`: `requires an authenticated admin in development`                                                                    | Preview provision/delete endpoint                                                                                                                                             | Delete                     | Loses preview-only admin/development provisioning assertions. Production status/disconnect authentication and uninstall authorization remain independently exercised. OAuth start authorization belongs to the API owner's new suite.                                                                                                                   |
| `integrations-discord.test.ts`: `rejects supplied Okou identity fields and conflicting guild ownership`                                             | Preview body accepted guild/bot/user IDs; raw forged identity fields sent to preview endpoint                                                                                 | Delete                     | Loses this preview request's strict-field rejection and guild-ownership conflict assertion. Meaningful OAuth owner-conflict coverage must be independently established in the API owner's suite; it is not declared redundant here.                                                                                                                     |
| `integrations-discord.test.ts`: `converges repeated concurrent provisioning on the same verified connection`                                        | Concurrent preview provisioning with caller-selected Discord proof                                                                                                            | Delete                     | Loses preview connection-ID convergence assertion. Independent OAuth attempts/replays have different state semantics; no equivalence claimed.                                                                                                                                                                                                           |
| `integrations-discord.test.ts`: `allows only one guild to win concurrent installation for an organization`                                          | Concurrent preview provisioning bypassing authorization                                                                                                                       | Delete                     | Loses this declaration's concurrent installation exclusivity assertion. Genuine OAuth concurrency/conflict coverage is delegated to the API owner, not claimed by this migration.                                                                                                                                                                       |
| `integrations-discord.test.ts`: `scopes fixture deletion to the authenticated organization`                                                         | Preview deletion endpoint                                                                                                                                                     | Delete                     | Loses preview deletion isolation assertion. Production disconnect/uninstall organization isolation remains covered by the separate settings tests.                                                                                                                                                                                                      |
| `integrations-discord.test.ts`: `rolls back a DM selection cancelled after its INSERT without publishing`                                           | Private SQL INSERT barrier and row-count observer                                                                                                                             | Delete                     | Loses exact post-INSERT rollback and no-publication assertion under internal cancellation timing. Public DM selection, sender/user ownership rejection, revocation, and disconnection tests remain. Remove orphan `test-fixtures/discord-preference.ts`; do not replace with another fault hook.                                                        |
| `integrations-discord.test.ts`: `keeps configured bindings unavailable until their owner enables the feature`                                       | Previously provisioned a binding while feature off                                                                                                                            | Rewrite                    | Install through OAuth while enabled, then disable through the feature API and observe unavailable status. Retains rollback visibility, not feature-off private provisioning.                                                                                                                                                                            |
| `discord-lifecycle.test.ts`: `exports every owned Discord record, including pre-route ingress and deliveries, without another member's data`        | Preview `history` inserts route/ingress/context/notice rows; `test-user-export-work` drives an internal export worker and `email-outbox-state` reads/deletes application rows | Delete                     | Loses Discord export archive contents/counts, pre-route notice/redaction, peer exclusion, and completed-export assertions in this declaration. No other suite is claimed equivalent. Remove its local `exportWork`, storage/outbox/zip/chat imports and seeded history support. Shared export helpers remain for other consumers; no unrelated cleanup. |
| `discord-lifecycle.test.ts`: `removes a departed member's binding only in the affected organization`                                                | Preview bindings and a post-departure current-org observer                                                                                                                    | Rewrite                    | Install owner/other-org bindings and connect peer through OAuth; drive signed Clerk membership deletion. Observe isolation through surviving peer and the same user's other organization, not a fabricated restored membership. Direct departed-current-org connected-state assertion is not retained.                                                  |
| `discord-ingress.test.ts`: `tells a member without an accessible agent immediately`                                                                 | `seedLegacyPrivateDefaultAgentFixture` privately makes the workspace default agent inaccessible                                                                               | Delete                     | Loses exact immediate inaccessible-default-agent notice and no-chat assertion for fabricated legacy metadata. Normal current writer does not construct that state. Remove this suite's import; shared legacy fixture is still used by unrelated suites and is not deleted.                                                                              |
| `discord-interactions-preferences.test.ts`: `switches the routed server thread the model picker runs in`                                            | Preview `history` links an arbitrary web chat to a Discord channel                                                                                                            | Rewrite                    | Genuine signed Gateway message creates the owned chat and admits a Run; authenticated Runner completion finishes the task. Retains thread-model change, member-default preservation, and public thread event assertions.                                                                                                                                |
| `discord-interactions-preferences.test.ts`: `switches the routed server thread to Auto as an empty selection`                                       | Same preview history link                                                                                                                                                     | Rewrite                    | Uses the same Gateway/Run/callback lifecycle. Retains Auto option, null thread model, and picker preselection.                                                                                                                                                                                                                                          |
| `discord-interactions-preferences.test.ts`: `rechecks personal subscription access after a picker is issued without changing the member preference` | `routedModelFixture` used preview history                                                                                                                                     | Rewrite                    | Real routed conversation construction; retains revoked-model rejection and unchanged personal preference.                                                                                                                                                                                                                                               |
| `discord-interactions-preferences.test.ts`: `rejects a signed control with changed %s context`                                                      | `routedModelFixture` used preview history                                                                                                                                     | Rewrite all three branches | Sender, channel, and expired branches remain; genuine routed conversation replaces seeded history.                                                                                                                                                                                                                                                      |
| `discord-interactions-preferences.test.ts`: `applies no selection when Discord's acknowledgement is uncertain`                                      | `routedModelFixture` used preview history                                                                                                                                     | Rewrite                    | Keeps external Discord acknowledgment failure, no-change notice, and preserved model assertions.                                                                                                                                                                                                                                                        |
| `discord-interactions-preferences.test.ts`: `rejects a model selection revoked by %s during access revalidation`                                    | `routedModelFixture` used preview history                                                                                                                                     | Rewrite all four branches  | Disconnect, feature, subscription disconnect, and disconnect-after-binding-read branches remain. Revocation is driven through production APIs from the external provider response boundary.                                                                                                                                                             |
| `integrations-discord-native.test.ts`: `denies bot DM content to every organization's run token while keeping DM sends`                             | Locally signed tokens naming random unadmitted Runs                                                                                                                           | Rewrite                    | Both organizations get genuinely admitted/claimed Runs. Retains DM content privacy and native sends.                                                                                                                                                                                                                                                    |
| `integrations-discord-native.test.ts`: `enforces default-off and token capabilities for reads and writes`                                           | Private bindings while disabled and arbitrary capability JWT                                                                                                                  | Rewrite                    | Install while enabled, then disable for default-off denial. Issue actual Run while off, then enable to test its missing capabilities. Retains read/write denials without forging token capabilities.                                                                                                                                                    |
| `integrations-discord-files.test.ts`: `requires native read or write capability for sandbox requests`                                               | Locally signed sandbox token naming a random Run                                                                                                                              | Rewrite                    | Runner claim supplies sandbox token; retains file read/write capability denials.                                                                                                                                                                                                                                                                        |
| `integrations-discord-files.test.ts`: `keeps a Run-owned Discord upload visible in its originating chat thread`                                     | Real admitted Run, but locally minted capability JWT                                                                                                                          | Rewrite                    | Claim the admitted Run and use its issued Okou token; retain canonical originating-thread artifact assertion.                                                                                                                                                                                                                                           |

Totals: **9 declarations deleted** (six preview-only, one SQL barrier, one
private export construction, one private legacy-agent construction). No
parameter branches deleted. All six routed preference declarations, including
three context branches and four revocation branches, are rewritten, not removed.

## Additional reachable-state correction

`integrations-discord.test.ts`: `rejects DM selections for another Discord sender
or another Okou user` previously provisioned the same Discord sender for two
Okou owners and expected selection notifications for both. That private phase is
incompatible with the actual OAuth ownership constraint. **Rewrite** the
foreign-owner branch using that owner's independent, genuinely authorized
Discord account; retain all three attempted selection IDs (another sender of the
same Okou user, a foreign owner, and an unknown ID), 404/no-existence-leak
responses, the owner's visible binding list, and successful own selection.
The impossible same-sender/cross-owner state and foreign-owner notification
expectation are not retained. No declaration or parameter branch is deleted by
this correction.

The native multi-organization DM privacy declaration now sends through real
Run-issued tokens, so accepted messages include normal agent/model attribution.
It verifies the delivered text while allowing that genuine attribution, rather
than requiring the unattributed string produced by invented Runs. Read denial
and cross-organization content privacy assertions remain unchanged.

## Final export-boundary correction

A subsequently attempted `discord-oauth-export.test.ts` requested export through
the user API but completed it through `GET /api/cron/process-background-jobs`
with `CRON_SECRET`. Current main's API and external-behavior guides explicitly
exclude that operator interface from user-case construction. The attempted case
and its claimed coverage were therefore withdrawn, not retained as an exception.
Without that operator drive, the real POST's bounded initial work leaves the
job `running`; the completed archive cannot be observed through this test's
user-accessible chain. No worker call, private driver, enlarged product work
budget, or endpoint added only for testing replaces it. The original archive
coverage loss above remains genuine, including the unverified new OAuth-attempt
projection; four unrelated durable-export cleanup passes do not resolve it.

## Retained suites and boundaries

`discord-fixture.ts`, `discord-ingress.test.ts`,
`discord-chat-write-compatibility.test.ts`, `internal-callbacks-discord.test.ts`,
`integrations-discord-files.test.ts`, `integrations-discord.test.ts`,
`discord-lifecycle.test.ts`, `integrations-discord-native.test.ts`, and
`discord-interactions-preferences.test.ts` use the public binding lifecycle.
Independently reachable authentication, guild/member permission, native read/send,
DM privacy, disconnect/uninstall, file publication, Gateway admission, Runner
callback, compatibility, and control-signature cases remain. The new
`discord-message-admission.test.ts` and parent-owned restored parity cases are
not modified by this work.

## Verification

### Final source and infrastructure

Verified on 2026-10-08 against the actual uniform production implementation
`4eaecfa2d86c54438b1eb75b6e83679c4f250006`, cherry-picked locally as dependency-only
`7688280db00ccc9470671f9c7331e2f8c38ccfc4`. It replaces the cookie-era routes with
start, provider callback evidence, separate consent approval, and owner completion.
Earlier cookie-route passes are **not** counted as final verification.

A fresh local PostgreSQL 18 database, `vm0_discord_final`, used UTC and the ordinary
`pnpm --filter @okouai/db db:migrate` command, including generated migrations
1347 and 1348. No manual application schema/row repair, business seed, internal
worker driver, or fault hook was used. `DATABASE_URL` was supplied to each run.

### Sequential runtime results

From `turbo/apps/api`, run each file separately using:

```sh
pnpm exec vitest run src/signals/routes/__tests__/<file>.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

| File                               | Final result                        |
| ---------------------------------- | ----------------------------------- |
| `integrations-discord`             | 12/12 PASS                          |
| `discord-lifecycle`                | 1/1 PASS                            |
| `discord-interactions-preferences` | 15/15 PASS                          |
| `discord-chat-write-compatibility` | 1/1 PASS                            |
| `internal-callbacks-discord`       | 26/26 PASS                          |
| `integrations-discord-native`      | 45/45 PASS                          |
| `discord-ingress`                  | 39/39 PASS                          |
| `integrations-discord-files`       | 40/40 PASS after provider-ID repair |
| **Total**                          | **179/179 PASS**                    |

Only one Vitest process ran at a time. No full Vitest run, local dev server, or
test-timeout increase was used. Parent-owned restored parity/admission/Slack
suites and the API owner's new OAuth/security suite were not rerun or claimed
by this worker.

The first actual file-suite run had five failures, not silently discarded:

- `requires the bot to have ATTACH_FILES in addition to readable channel access`:
  expected HTTP 200, received HTTP 502 `DISCORD_ERROR`.
- `refreshes an expired CDN URL once from the same message identity`: bounded
  `Discord OAuth callback did not reach the approval landing` setup failure.
- `does not expose another organization's asset through materialize or complete`:
  expected HTTP 200, received HTTP 400 `BAD_REQUEST`, with
  `guildId: Discord snowflake ID exceeds the unsigned 64-bit range`.
- `publishes one canonical artifact before delivery and reuses its receipt`:
  the same bounded callback setup failure.
- `reports a Discord rate limit without sending again on a later completion`:
  expected HTTP 200, received HTTP 502 `DISCORD_ERROR`.

The existing `helpers/discord-file-provider.ts` generator added 10^18 to a full
random uint64, allowing malformed provider IDs above the unsigned 64-bit limit.
The final client correctly uses the strict shared Snowflake schema. The repair
reuses the existing bounded `uniqueDiscordSnowflake` generator; it does not add
schema defaults, change permission/privacy assertions, or fabricate application
state. The complete 40-case file suite then passed. The other source alignment
uses `mockEnv` for the newly typed `DISCORD_OAUTH_CLIENT_SECRET`, rather than the
separate optional-environment override.

### Static checks and reproduction

Scoped Prettier, ESLint, Oxlint (including type-aware mode), native TypeScript,
and `git diff --check` passed for the eight suites plus their four modified
Discord helpers/import graph. TypeScript used an ignored, local
`.typecheck/tsconfig.discord-public-lifecycle.json`: extend `../tsconfig.json`,
set `incremental: false`, `noEmit: true`, and `rootDir: "../../.."`, set
`include: []`, and list the eight suite files above plus
`helpers/discord.ts`, `helpers/discord-fixture.ts`, and `helpers/discord-run.ts`
with paths relative to `.typecheck` (`../src/signals/routes/__tests__/...`).
`discord-file-provider.ts` is included through the file suite's import graph.

```sh
pnpm exec tsc -p .typecheck/tsconfig.discord-public-lifecycle.json \
  --noEmit --checkers 1
```

No production deployment, Discord activation, real-provider OAuth exercise,
credential configuration, merge, or whole-repository test claim is made here.

### Retirement inventory

At `d818f4fae0819d57df03e5ff6d3595fe1b0acd91`, repository search for
`seedDiscordFixture|deleteDiscordFixture|testDiscordStateContract|discordStatePreviewRoutes|/api/test/discord-state`
(excluding this ledger and the lockfile) has **zero matches in the migrated
helpers/suites**. The complete remaining 19 matches are:

| Remaining file                                                       | Matches | Responsibility                                          |
| -------------------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `turbo/apps/api/src/signals/routes/discord-state-preview.ts`         | 7       | Parent-owned preview route deletion                     |
| `turbo/apps/api/src/signals/route.ts`                                | 2       | Parent-owned preview registry deletion                  |
| `turbo/packages/api-contracts/src/contracts/test-discord-state.ts`   | 3       | Parent-owned preview contract deletion                  |
| `docs/discord-integration.md`                                        | 4       | Parent-owned canonical guide update                     |
| `docs/implementation/issue-37440-batches/baseline/test-only-api.csv` | 2       | Historical baseline evidence, not an active constructor |
| `docs/implementation/discord-parity-37968-testing.md`                | 1       | Parent-owned parity migration record                    |

A second scoped search in the eight suites and
`helpers/discord{,-fixture,-run,-file-provider}.ts` also returns zero matches for
`history[?]:|fakeRun|signSandboxJwtForTests|auth/tokens|test-fixtures/|testUserExportWorkContract|emailOutboxStateContract|withDiscordDmPreferenceInsertBarrierFixture|seedLegacyPrivateDefaultAgentFixture`.
The orphan `test-fixtures/discord-preference.ts` is deleted. Parent route/contract
remnants on this isolated branch are not falsely reported as fully retired;
PMO performs the integrated repository retirement check.
