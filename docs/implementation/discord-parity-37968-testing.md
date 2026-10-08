# Discord parity #37968 coverage and public lifecycle

Apply [API testing](../testing/api-testing.md#external-behavior-boundary) and
[external behavior](../testing/testing-external-behavior.md#cases-without-public-construction)
to the complete construction, drive and observation chain, including helpers.
External Clerk/Discord mocking is permitted; inserting Okou binding/history
business rows is not.

## Historical finding and scope change

The original nine new declarations depended on `seedDiscordFixture` ->
`POST /api/test/discord-state`, directly or through `setupConnectedDiscordActor`.
They were removed in the initial review repair. That removed **nine declarations /
ten executions** of meaningful success/privacy/revocation behavior, not redundant
copies or already-proven coverage. Request/admission validation did not replace
those execution paths.

On 2026-10-08, the owner authorized genuine Discord OAuth authorization, server
installation and member linking, and expressly retired the preview constructor.
The route, contract, registration and private construction helpers are removed;
there is no renamed privileged replacement. Product authorization, consent-browser
approval and authenticated completion now establish the prerequisite binding.
The original parity cases are restored in
`turbo/apps/api/src/signals/routes/__tests__/discord-conversation-parity.test.ts`
through that public lifecycle.

| Exact declaration                                                                                                            | Meaningful behavior restored                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| combines parent context, the thread starter, an older quoted message and attachment-only history within one bounded snapshot | Authorized context selection/bounds, attachment-only metadata and signed-URL exclusion. |
| omits unavailable parent history and never follows a reference into another channel                                          | Optional-parent omission and cross-channel reference isolation.                         |
| keeps an explicit DM reference out of the Agent's context                                                                    | Shared physical bot-DM privacy.                                                         |
| adds run attribution once to a split native send                                                                             | Genuine Run-scoped attribution and one footer before splitting.                         |
| references the same-channel message only on the first long-message chunk                                                     | Exact target, first-segment-only reference and complete text.                           |
| does not deliver a reply to a %s message                                                                                     | Both `deleted` and `other-channel` branches reject without delivery.                    |
| revalidates write access after reading a reply target                                                                        | Revocation between authorized target read and delivery.                                 |
| requires shared history access for a guild reply without restricting ordinary writes                                         | History permission for referenced guild sends, not ordinary writes.                     |
| references the sender's own bot DM without reading its content                                                               | Own-DM referenced send without reading private content.                                 |

Restored construction is `setupConnectedDiscordActor` -> real authenticated
OAuth start -> signed provider callback -> consent-browser approval ->
authenticated completion -> public status. Provider mocks control only external
Discord responses. Connection IDs come from product status. Cleanup uses the
actual caller's personal disconnect and administrator uninstall.

Native ordinary sends use a device-issued CLI token. Attribution/context cases
admit work through the signed production Gateway, observe canonical Chat events,
heartbeat/claim through the real Runner interface, and use its issued
`platformEnvironment.OKOU_TOKEN`; they do not sign a random-Run JWT. Context is
observed in the genuine Runner claim and messages through public native reads
or external provider requests/receipts.

**Execution status:** all ten restored executions passed against the final uniform
start/callback/consent-browser approval/opener completion implementation. The
focused command was `pnpm --filter api exec vitest run
src/signals/routes/__tests__/discord-conversation-parity.test.ts --maxWorkers=2`.
The first integration run exposed a test environment override mismatch; aligning
the registered OAuth client-secret mock with the production `env` reader resolved
it without changing product configuration or weakening checks. Admission validation and
Slack regressions were not substituted for these ten execution paths. The separate
[legacy retirement ledger](discord-public-test-lifecycle.md) records other deleted
private-only cases/phases and genuine rewrites without calling lost coverage
redundant.

## Independently reachable verification

- `discord-message-admission.test.ts` still exercises malformed/out-of-range reply
  IDs and default-off rejection through the real send route, with Clerk identity
  mocks only and no binding/Run construction.
- CLI Commander/MSW tests and actual piped-stdin subprocesses retain exact reply
  IDs, multiline input, explicit-text precedence, bounds, destination and history
  reference presentation. `discord connect` enters authenticated App settings;
  no CLI process tries to plant its own nonce cookie in the consent browser.
- Existing Slack send regressions test shared attribution separately. No new
  Slack private business setup is introduced or presented as Discord acceptance.
- Product OAuth tests must independently cover application/scopes/identity/guild
  proof, current membership/admin/gate, wrong consent-browser owner, state/proof
  mismatch, expiration/replay/concurrent claims, identity/org exclusivity,
  legitimate idempotence and welcome once. Anonymous callback success or a URL
  status cannot grant a binding.

No live Slack/Discord, production configuration, Gateway deployment or activation
is established. Both feature and Gateway remain default-off. Record exact revision,
commands/results and limits before claiming automated or separately authorized
real-guild acceptance.
