# App rebuild hosted site sharing and chat artifact batch

Main is merged through `8257ce69` in `5fcdb766`; that range changed no
Platform, UI or API contract files. All 44 accepted files register 172
frozen executions and 3 selected upstream additions, and all 175 pass.
Their frozen baseline is 315 executions, so the verified reduction is
143 (45.4%). The final 30% gate still uses the complete suite's actual
registered count.

| Scope                      | Files | Frozen executions | Registered and passed |
| -------------------------- | ----: | ----------------: | --------------------: |
| Rebuilt in this round      |    10 |               126 |                    66 |
| All accepted files         |    44 |               315 |                   172 |
| Remaining frozen BDD scope |   441 |             4,796 |   2,509 still to keep |

| File                           | Frozen executions | Registered and passed |
| ------------------------------ | ----------------: | --------------------: |
| Hosted site sharing            |                40 |                    20 |
| Chat artifact deletion         |                 4 |                     2 |
| Chat artifact sidebar preview  |                 5 |                     3 |
| Chat private artifact previews |                10 |                     5 |
| Chat artifact download         |                11 |                     6 |
| Chat artifact action group     |                15 |                     8 |
| Chat hosted site URL           |                 7 |                     4 |
| Markdown artifacts             |                 7 |                     4 |
| Chat run artifact carryover    |                10 |                     5 |
| Chat hosted site download      |                17 |                     9 |

The [execution ledger](test-rebuild-rebuilt-executions.tsv) maps each
frozen registration to one selected ID. Runtime rows from `vitest run`,
static declarations from `vitest list` and ledger rows match in both
directions. The [GWT checklist](test-rebuild-gwt-checklist.tsv) now
covers all 175 registered IDs, including 783 Then items.

## Independent audit

Three read-only auditors mapped each new file against its frozen BDD
before acceptance. Every registration matched one selected ID. They
found eight weak Then assertions, seven unstated assertions and three
helper parameters left over from unselected variants. All were fixed
before the BDD files were removed:

- Hosted site sharing now checks the user-event clipboard before Save,
  keeps the banner switch mounted, gives the organization audience its
  own temporary preview and checks the settled server audience. Its
  helper no longer accepts unused visibility and banner options.
- Chat artifact deletion waits for the thread artifacts to be re-read
  before checking that the reopened artifact has no Delete action.
- Chat run artifact carryover takes the action bar from the final result
  and rejects both collapsed and expanded work-history toggles.
- Unstated telemetry surfaces and Markdown link destinations were
  removed. The private preview helper no longer accepts an unused
  reference parameter, and the action group content helper no longer
  carries an unused surface parameter.

## Upstream additions

[Separate upstream ledger](test-rebuild-upstream-rebuilt-executions.tsv)

| Upstream ID                                            | Disposition  | Basis                                                                             |
| ------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------- |
| `upstream-eaae30ac-chat-run-artifact-carryover-135-01` | Registered   | Retained in the [`eaae30ac` ledger](test-rebuild-upstream-eaae30ac-scenarios.tsv) |
| `upstream-48919-artifact-toolbar-dialog-ungrouped`     | Registered   | Ungrouped actions are the default user experience                                 |
| `upstream-48919-artifact-toolbar-sidebar-grouped`      | Registered   | Covers More before the separator and the sidebar close control                    |
| `upstream-48919-artifact-toolbar-dialog-grouped`       | Not selected | Grouping is staff-only and the dialog order is covered above                      |
| `upstream-48919-artifact-toolbar-sidebar-ungrouped`    | Not selected | The sidebar close control and Download order are covered above                    |

The four #48919 rows had no disposition before. They follow the
rounded-half rule for that file. `upstream-eaae30ac-chat-run-artifact-carryover-197-01`
remains not selected. These additions stay outside the frozen
denominator.

## CI on `38201c80`

All 8 `test-app` shards passed, taking 1m00s, 1m11s, 1m14s, 1m25s,
1m07s, 1m13s, 1m21s and 1m13s. Five checks failed:

- `Pull Request Title`: the subject contained `BDD`. The title is now
  lower-case, and the check reads the title on the next run.
- `ci-gate-security`: failed only because of the title check.
- `lint-eslint`: all 439 errors are parsing errors for temporary BDD
  Markdown files.
- `lint-knip`: reports 36 unused helper files and 36 unused exports or
  types that only cleared tests used. Rebuilt files will consume some
  of them, and final cleanup removes the rest.
- `ci-gate-turbo`: aggregates the ESLint and Knip results.

The ESLint and Knip results come from temporary rebuild state and stay
in the close-out list with the temporary BDD files.

## Review questions for Ethan

Earlier questions remain in the [first](test-rebuild-batch-one.md) and
[fifth](test-rebuild-batch-five.md) batches. This round adds:

- `hosted-site-sharing-001` reads "disables copying until ready" as a
  busy placeholder with no Copy link control, which is what the product
  renders while the address loads.
- `hosted-site-sharing-018` rejects the clipboard write by spying on
  `navigator.clipboard.writeText`, because the shared browser fixture
  has no rejecting option.
- `chat-artifact-deletion-001` shows that the artifact stays intact
  after Cancel through no delete request and visible preview content.
- `chat-private-artifact-previews-001` has no fragment to preserve for a
  relative reference, so it asserts the thumbnail built from the
  resolved original.
- `chat-run-artifact-carryover-009` uses a Markdown heading and bold text
  because the frozen BDD names them, while earlier tests used plain text.
- The #48919 selection above was made by the half-per-file rule without
  a separate review.

Next, rebuild the chat attachment and navigation artifact files:
`chat-attachment-artifact-viewer` (25 to 13), `chat-navigation-artifact-drive`
(22 to 11), `chat-attachment-annotation` (21 to 11),
`chat-navigation-artifact-sidebar` (15 to 8),
`chat-attachment-message-previews` (15 to 8) and
`chat-attachment-composer` (6 to 3).
