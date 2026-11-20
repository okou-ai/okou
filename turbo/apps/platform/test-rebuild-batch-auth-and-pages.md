# Auth and standalone pages rebuild

The batch uses the production Router with local Clerk, HTTP, realtime and
browser fixtures. Each file is restored from current `main` with only the
selected registrations and parameter rows. No selected body differs from the
frozen baseline. The execution ledger and
[GWT checklist volume 4](test-rebuild-gwt-checklist-4.tsv) record the
accepted expansion of each selected scenario. Final acceptance runs use one
Vitest worker, and type checking runs separately.

## Accepted files

The batch accepted 67 of 122 frozen rows across 20 files:
`default-error-boundary`, `auth-v1-navigation-hosts`, `auth-v1-ui-load`,
`auth-v1-viewport`, `auth-v1-page`, `integration-url-diagnostics`,
`safe-area`, `export-page`, `lab-page`, `mail-draft-page`,
`oauth-consent-page`, `preview-access`, `install-banner`, `queue`,
`redeem-campaign-page`, `link-navigation`, `skill-import-dialog`,
`workflow-instructions`, `ssh-cloudflare-access` and `ssh-delete-conflicts`.
They passed targeted Vitest, Platform test TypeScript, ESLint and both Oxlint
configurations before BDD removal.

## Given/When/Then adjustments

An independent review checked every selected item against the test body in
both directions. Where the setup contradicted a premise or a stated Then was
not asserted, the case now matches its scenario. No case was added.

| ID                                         | Part  | Change                                                            |
| ------------------------------------------ | ----- | ----------------------------------------------------------------- |
| `ssh-cloudflare-access-005`                | Given | The protected host uses port 22, as the scenario states.          |
| `ssh-cloudflare-access-005`                | Then  | The submitted port and the reopened Port field are 22.            |
| `ssh-cloudflare-access-006`                | Then  | The Cloudflare Access selector keeps the alternate configuration. |
| `ssh-delete-conflicts-007`                 | Then  | The deleted connection name is gone.                              |
| `skill-import-dialog-014`                  | Then  | The case waits for the realtime subscription before Escape.       |
| `auth-v1-page-006`                         | Then  | The hosted sign-in path matches exactly.                          |
| `mail-draft-page-004`                      | Then  | No chat composer appears after deletion.                          |
| `integration-url-diagnostics-009` to `013` | Then  | The whole original event is unchanged after redaction.            |

These items are covered as written. The checklist notes record why.

- `ssh-cloudflare-access-003` prefills the published hostname from the host
  and submits it unchanged.
- `mail-draft-page-006` would reset the mocked status to sending on a resend,
  so the Sent result rules a resend out.
- `integration-url-diagnostics-009` to `013` open sign-in with the signed
  continuation, the state a redirect from the signed path produces.
- `export-page-001` models the cooldown as the server's 429 response.
- `redeem-campaign-page-002` takes non-admin status from the server's
  `admin_required` response.

## Parameter lists rebuilt by hand

Two files register their rows through lists that the restore script cannot
prune, so their selected rows are written out by hand.

- `color-themes` iterated every non-default palette through an imported list.
  The two `it.each` lists now name the selected palettes: golden-hour and
  citrus-spark for labels, and golden-hour, citrus-spark, berry-blush,
  cotton-sky and blue-horizon for ambient strength. The palette set on
  `main` is unchanged from the baseline. Seven of 14 rows are accepted.
- `chat-capability-voice-isolation` repeats one case through
  `describe.each`. The list keeps the user change, with an explicit type
  argument that preserves the original union. Two of three rows are accepted.

## Zero-selection file

`msw-contract` had nine frozen rows and none selected. Screening removed
`002` to `008` because they exercise MSW dispatch, decoding and fallback with
no App user action or observable product result. The confirmed deductions
removed `001` and `009` for the same reason: synthetic contracts and direct
calls against the fixture transport. The file closes with its BDD removed and
no rebuilt test file. Its nine rows count toward the frozen denominator with
zero accepted.

## Fixture cleanup

The rebuilt `queue` uses `queue-page-test-helpers` again. The selected
`auth-v1-page` cases do not use `presentation-onboarding-fixture`, and no
pending file does, so it is removed. The remaining Platform Knip findings are
used by pending files: `rail-browser-layout` by `composer-task-chips`,
`mockClerkSessionTransitioning` by `clerk-user`, the two Ably wait helpers by
`realtime`, and `buttonByLabel` by `chat-scroll`.

## Signals, library and shared database files

The second batch accepted 63 of 113 frozen rows across 20 files:
`shared-worker-failure`, `shared-worker-preload`, `chat-thread-link`,
`preview-bypass-cookie`, `sentry-reporting`, `visual-viewport-keyboard`,
`platform-direct-bridge`, `single-connection-client`, `worker-runtime`,
`api-client-bootstrap`, `auth-oauth-consent`, `clerk-user`,
`command-scheduling`, `fetch`, `realtime`, `shared-database-browser`,
`startup-diagnostics`, `user-timezone-initialization`,
`session-output-stream` and `unread-through-at`.

The review found no premise or outcome gaps. Three cases now assert more of
their stated Then: `api-client-bootstrap-001` checks the exact token call
count, `realtime-002` re-checks the token history after completion, and
`startup-diagnostics-001` asserts the inert Agents heading is visible. A
comment describing an unselected `sentry-reporting` case was removed.

`realtime-010` asserts the channel subscription is gone after a failure. The
Ably fixture also clears subscriptions when a channel fails, so that check
cannot tell app cleanup from fixture cleanup. The checklist records this
limit for review. The rebuilt `clerk-user` and `realtime` files use
`mockClerkSessionTransitioning` and the two Ably wait helpers again.

## Startup, storage, composer and connector files

The third batch accepted 116 of 224 frozen rows across 14 files:
`clerk-bootstrap`, `chat-idb`, `indexeddb-client`, `user-message-document`,
`voice-draft-audio`, `authentication-startup`, `platform-entrypoint`,
`message-port`, `chat-session-output-stream`, `composer-task-chips`,
`tailscale-parity`, `marketing-handoff-recovery`, `prompt-link` and
`wallet-action-card`.

The review found three gaps, now closed, and one weak check, now strengthened.
No case was added.

| ID                               | Part  | Change                                                                  |
| -------------------------------- | ----- | ----------------------------------------------------------------------- |
| `indexeddb-client-003`           | Then  | The creation event also leaves out the key and value.                   |
| `message-port-032`               | Then  | Catch-up requests are counted, and none follow the indicator change.    |
| `chat-session-output-stream-006` | Given | The run opens on app.okou.ai, as the scenario states.                   |
| `wallet-action-card-002`         | Then  | No continuation is sent once Continue appears and before it is clicked. |

`message-port` and `marketing-handoff-recovery` each narrow one parameter
list to its selected row. Explicit type arguments keep the original unions.
The other review points are wording or timing limits, recorded as checklist
notes. The selected `composer-task-chips` cases do not use
`rail-browser-layout`, and no pending file does, so it is removed.

## Continuation, onboarding and connector pages

The fourth batch accepted 68 of 134 frozen rows across four files:
`integration-continuation`, `discord-connect-page`, `get-started-entry` and
`slack-connect-page`. `get-started-entry-022` now asserts that no Gmail
dialog opens, `get-started-entry-026` asserts the dialog closes before the
pending refresh is released, and `slack-connect-page-011` asserts the forged
workspace name is absent. At the reward limit, the `get-started-entry-006`
row shows the quest name Connect a connector rather than the catalog
description. The checklist note records this wording difference.

## Deferred files

These files keep their BDD and are not counted as accepted.

| File                   | Evidence                                                                                                                                                                                                                                                           | Next step                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `auth-v1-oauth`        | All 15 selected rows pass. The Given of `025`, `027` and `030` says the user is signed out, but each case uses the signed-in default. `030` needs a session for the Clerk continuation it asserts. `025` and `027` check that an active session is not redirected. | Decide whether the scenarios describe a signed-in session or whether the cases should start signed out. |
| `integrations-discord` | All 24 selected rows pass. For the connected row of `016`, the case requires a Connect action, while the Then says none appears. `023` does not assert that the connected state is absent. `033` opens the menu with a pointer click rather than the keyboard.     | Confirm the connected-row behavior on the current page, then align `016` and close `023` and `033`.     |
| `chat-run-models`      | One selected parameter list iterates a derived constant, which the restore script cannot prune.                                                                                                                                                                    | Write the selected rows out by hand, as for `color-themes`.                                             |
| `integrations-feishu`  | Some registrations use template-literal titles, which the restore script cannot match.                                                                                                                                                                             | Map those registrations by hand.                                                                        |
