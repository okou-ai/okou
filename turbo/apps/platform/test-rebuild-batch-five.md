# App rebuild BDD conformance audit and shared artifact batch

Main is merged through `dd337098` in `9ce6c85b`. All 34 accepted files
register 106 Vitest executions. Each execution maps to one selected
frozen ID, and all 106 pass on the merged head. Their frozen baseline is
189 executions, so the verified reduction is 83 (43.9%). The final 30%
gate still uses the complete suite's actual registered count.

| Scope                      | Files | Frozen executions | Registered and passed |
| -------------------------- | ----: | ----------------: | --------------------: |
| Re-audited earlier files   |    20 |                90 |                    51 |
| Rebuilt in this round      |    14 |                99 |                    55 |
| All accepted files         |    34 |               189 |                   106 |
| Remaining frozen BDD scope |   451 |             4,922 |   2,575 still to keep |

## Conformance standard

The [GWT checklist](test-rebuild-gwt-checklist.tsv) records every Given
premise, When action and atomic Then claim of the 106 accepted IDs. A
Then sentence is split at each separate observable claim, including
negative claims. Every row names the test lines at `b6586901` that set up
the premise, perform the action or assert the claim. A Then claim is
covered only when its assertion would fail if that claim regressed. All
504 Then items are covered or explicitly amended by upstream.

The [execution ledger](test-rebuild-rebuilt-executions.tsv) is reconciled
in both directions. Each runtime row from `vitest run` matches one static
declaration from `vitest list` and one ledger row. The reverse also
holds, and every ledger ID is a selected frozen ID or the documented
replacement below. No case or parameter variant was added. The three
`test.each` tables expand only selected rows.

Assertions about behavior the BDD does not state were removed. Two kinds
of check remain because they establish the scenario rather than add one:
request identity checks inside external mock handlers (for example, the
artifact reference or continuation thread being requested) and checks
confirming that the When action took effect (for example, the document
leaving native fullscreen). Readiness waits are not counted.

## Re-audit of the earlier 20 files

The earlier files register no extra cases, and their 51 executions are
unchanged. The audit found missing or weaker Then assertions. They are
now asserted in their original cases:

- `email-unsubscribe-page-002`: the Okou image is present.
- `banking-connect-return-page-002`: the success path replaces the
  browser history entry.
- `hosted-site-access-002`: the verification heading is shown and the
  denial heading is absent. In `-004`, the full guidance asks the sharer
  to check access.
- `permission-allow-page-007`: an existing denial shows no expiry.
  `-009` and `-010` show the update-permissions prompt.
- `shared-thread-presentation-002`: no rich-content loading indicator
  remains. In `-005`, the surrounding prompt text is visible.
- `anonymous-shared-artifact-page-001`: the filename heading is shown and
  no sign-in prompt appears. In `-003`, the Artifacts heading is a
  heading, and neither a preview, an iframe nor a sign-in prompt appears.
  Its previous no-preview check could not fail.
- `shared-thread-private-artifacts-001`: the PDF preview card keeps the
  stable link independently of the download link.
- `shared-thread-diagrams-001`: the expanded diagram stays in the
  conversation.
- `shared-artifact-fullscreen-001`: the unsupported premise removes
  `requestFullscreen`, and the title hides and returns with the header.

Removed out-of-scope assertions include permission write payloads,
grant-save ordering, a completed title in `permission-batch-page-003`,
no-write and no-continuation counts, an unstated download blob, a
trailing URL check and an unstated `rel` value. `permission-allow-page-003`
now owns its pending-state assertions, which `-004` no longer repeats.

### Upstream replacement and amendments

| Frozen ID                   | Status                  | Current carrier                                                                              | Basis                                                                                                                                |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `permission-batch-page-001` | Replaced                | `permission-batch-page-003`, "Grouped grants remain allowed when chat continuation succeeds" | Main removed the rollout-only chat-account variant. Row 559 of the [`eaae30ac` ledger](test-rebuild-upstream-eaae30ac-scenarios.tsv) |
| `permission-batch-page-002` | Given 4, Then 4 amended | Connector-wide scope note in the same test                                                   | The chat-account switch and agent-scope copy were retired. Row 562                                                                   |
| `permission-batch-page-006` | Then 2 amended          | The single GitHub write and the second agent's continuation                                  | Grants are connector-wide and carry no agent ID. Row 564                                                                             |

The replacement keeps one execution for the selected success intent.
`-003` was not selected in the frozen selection, and `-001` is no longer
registered on main.

### Verification gaps found in CI

The previous head failed `lint-type-app`. The rebuilt tests passed client
descriptors to `context.mocks.api`, which requires full route contracts,
and the test type check reported 41 errors. They now import
`@okouai/api-contracts/contracts/*`, and the test type check reports no
errors. Earlier rounds ran Oxlint without ESLint, so ESLint and Oxlint
rules were also violated. All 30 files now pass Prettier, Oxlint with
warnings denied, type-aware Oxlint and ESLint.

Package-wide ESLint still parses the remaining temporary BDD Markdown files
and reports parsing errors. That clears when the temporary BDD files are
removed at the end. `lint-knip`, the pull request title check and the
aggregate gates also failed on the previous head and remain open for the
final stage. Locally, `lint:build-config` cannot resolve `pandoc-wasm` in
this checkout's environment and was not used as evidence.

## Rebuilt in this round

| File                          | Frozen executions | Registered and passed |
| ----------------------------- | ----------------: | --------------------: |
| Shared artifact page          |                10 |                     5 |
| Shared conversation actions   |                 9 |                     5 |
| Shared artifact deletion      |                11 |                     6 |
| Shared conversation lightbox  |                15 |                     8 |
| Artifact catalog cards        |                 3 |                     2 |
| Artifact catalog filters      |                 6 |                     3 |
| Artifact catalog preview      |                 5 |                     3 |
| Artifact deletion             |                 5 |                     3 |
| Artifact catalog sidebar      |                 8 |                     4 |
| Artifact sharing              |                 7 |                     4 |
| Chat artifact image viewer    |                 5 |                     3 |
| Chat artifact download type   |                 7 |                     4 |
| Chat artifact diagram overlay |                 3 |                     2 |
| Chat artifact actions         |                 5 |                     3 |

An independent audit read each file against its frozen BDD before
acceptance. It found one missing claim: a prompt image attachment must
not also open a new tab. It also found an unstated download URL check and
an Escape check that could pass after a delayed close. These were fixed
before the BDD files were removed. The four chat artifact files had no
open findings; an explicit check that the document stays open after the
first Escape was added before acceptance. The access page for `shared-artifact-page-007`
registers only the selected 404 row, and its helper no longer accepts
the unselected 403 status.

## Upstream

The [`dd337098` sync](test-rebuild-upstream-sync-dd337098.md) keeps seven
cleared files deleted and records 187 registrations: 148 unchanged and
39 with fixture or timing changes. Main added no registrations. The
shared page helper changed, and all accepted files were rerun on the
merged head. The 72 earlier mapping reviews are unchanged. None of them
belongs to this round's files.

## Review questions for Ethan

The [first batch](test-rebuild-batch-one.md) still holds the automation
retry template and invalid hosted return address questions. This round
adds:

- `shared-artifact-deletion-005` and `artifact-deletion-003` assert
  "Could not delete artifact", which the product shows from the service
  error message. The baseline asserted the same text.
- `artifact-sharing-002` states that only one permission-status read
  occurs, so its test counts requests even though page tests normally
  avoid counting requests.
- `shared-artifact-page-007` treats the configured color theme attribute
  as the theme remaining visible. It does not assert system dark mode.
- `artifact-action-telemetry-004` follows the BDD's signed-out visitor,
  while the baseline test ran signed in. The fresh download URL therefore
  comes from the public artifact endpoint.
- `artifact-image-viewer-003` asserts the product's default 300% maximum
  zoom, because the test environment reports no layout width.

Next, rebuild `hosted-site-sharing` (40 to 20) and the remaining
artifact files under `okou-page`, applying the same checklist before
acceptance.
