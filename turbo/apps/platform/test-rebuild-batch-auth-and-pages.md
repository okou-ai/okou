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
