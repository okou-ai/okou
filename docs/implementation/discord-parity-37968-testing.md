# Discord parity #37968 coverage decision

This ledger resolves the test-construction finding on PR #37968. Apply
[API testing](../testing/api-testing.md#external-behavior-boundary) and
[external behavior](../testing/testing-external-behavior.md#cases-without-public-construction):
construct, drive and observe the whole lifecycle through production interfaces.
A guarded preview-only endpoint is not a production constructor. No fixture
exception, internal service test, replacement DB seed or new product endpoint
is introduced.

Discord binding onboarding remains deferred. These new cases cannot construct
that prerequisite through the existing production endpoints, which expose
status, disconnect/uninstall and DM selection but not a binding constructor.
The protected preview interface is retained for separately authorized manual
non-production setup; it is not automated API acceptance evidence.

## Removed unsupported additions

All nine declarations below were added by #37968 and depended on
`seedDiscordFixture` -> `POST /api/test/discord-state`. The endpoint inserts
installation/connection business rows and returns 404 in production. Ingress
reaches it through `connected()` -> `setupConnectedDiscordActor`; native cases
reach it through `fixture()`. Clerk identity/membership mocks themselves remain
valid external-provider infrastructure, not application business-row seeds.

| Exact new declaration                                                                                                        | Decision                                                            | Behavioral coverage lost or deferred                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| combines parent context, the thread starter, an older quoted message and attachment-only history within one bounded snapshot | Delete unsupported case                                             | Authorized context selection, bounds, attachment metadata and signed-URL exclusion |
| omits unavailable parent history and never follows a reference into another channel                                          | Delete unsupported case                                             | Optional-parent omission and cross-channel reference isolation                     |
| keeps an explicit DM reference out of the Agent's context                                                                    | Delete unsupported case                                             | Shared physical bot-DM privacy                                                     |
| adds run attribution once to a split native send                                                                             | Delete unsupported case                                             | Run-scoped Discord attribution and split placement                                 |
| references the same-channel message only on the first long-message chunk                                                     | Delete unsupported case                                             | Authorized first-segment reply and full-text preservation                          |
| does not deliver a reply to a %s message                                                                                     | Delete one declaration, both `deleted` and `other-channel` branches | Missing/cross-channel target rejection                                             |
| revalidates write access after reading a reply target                                                                        | Delete unsupported case                                             | Permission revocation between reference read and delivery                          |
| requires shared history access for a guild reply without restricting ordinary writes                                         | Delete unsupported case                                             | Sender/bot history permission versus ordinary writes                               |
| references the sender's own bot DM without reading its content                                                               | Delete unsupported case                                             | Own-DM referenced sending without content reads                                    |

This removes nine declarations / ten executed cases, not nine equivalent copies
of already-proven behavior. Their coverage is not claimed to overlap: the named
success/privacy/revocation paths remain an explicit acceptance gap. Removing
them follows the required construction policy, not a change to production
permission or privacy behavior.

Orphaned support removed with them: `claimMessage`, its contract/route/JWT/Zod
imports, and the native fixture's newly added reply-reference request/receipt
emulation. Existing Discord suites and shared fixture infrastructure are not
rewritten or newly endorsed by this focused change; broader retirement belongs
to the repository's existing test-boundary work.

## Retained and reachable verification

- `discord-message-admission.test.ts` uses only Clerk identity mocks and the real
  send route/contract. It rejects malformed, zero, fractional, negative and
  out-of-range reply IDs, and verifies default-off rejection with and without
  the optional reference, including the maximum unsigned 64-bit ID. It creates
  no Discord binding, business row, fabricated Run or privileged preview state.
- Discord CLI tests enter through Commander and MSW; subprocess cases read actual
  piped stdin. They retain exact reply IDs, destination preservation, multiline
  stdin, explicit-text precedence, empty/oversized input guidance, history
  reference presentation and snowflake validation.
- Existing Slack native-send regressions exercise the shared attribution
  extraction. Their result is reported separately from the public-construction
  status of pre-existing test helpers; no new private fixture dependency is added.
- Production source review verifies bounded context, exact target resolution,
  independent parent access, connection checks, post-reference write
  revalidation, DM-history early exits and mention-notification suppression.
  Source review is not a substitute for executing the deferred acceptance paths.

No live Discord/Slack, Gateway deployment or production activation is authorized
or established by this ledger. The integration remains default-off. Before an
explicit test rollout, execute the authorized acceptance checklist and record
its exact revision, environment, authorization and outcome. A future production
binding lifecycle permits new complete API tests without a fixture exception.
