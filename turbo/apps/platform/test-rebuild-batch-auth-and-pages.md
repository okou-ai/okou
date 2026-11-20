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
