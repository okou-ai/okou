# App rebuild chat attachment and navigation artifact batch

Main is merged through `97077ee5` in `03248050`; that range changed no
Platform, UI or API contract files. All 50 accepted files register 226
frozen executions and 3 selected upstream additions, and all 229 pass.
Their frozen baseline is 419 executions, so the verified reduction is
193 (46.1%). The final 30% gate still uses the complete suite's actual
registered count.

| Scope                      | Files | Frozen executions | Registered and passed |
| -------------------------- | ----: | ----------------: | --------------------: |
| Rebuilt in this batch      |     6 |               104 |                    54 |
| All accepted files         |    50 |               419 |                   226 |
| Remaining frozen BDD scope |   435 |             4,692 |   2,455 still to keep |

| File                             | Frozen executions | Registered and passed |
| -------------------------------- | ----------------: | --------------------: |
| Chat attachment composer         |                 6 |                     3 |
| Chat attachment artifact viewer  |                25 |                    13 |
| Chat navigation artifact sidebar |                15 |                     8 |
| Chat navigation artifact Drive   |                22 |                    11 |
| Chat attachment message previews |                15 |                     8 |
| Chat attachment annotation       |                21 |                    11 |

The [execution ledger](test-rebuild-rebuilt-executions.tsv) and the
[GWT checklist](test-rebuild-gwt-checklist.tsv) cover all 229 registered
IDs, including 1,001 Then items. Runtime rows, static declarations and
ledger rows match in both directions.

## Independent audit

Three read-only auditors mapped each file against its frozen BDD before
acceptance. Every registration matched one selected ID, with no leftover
variants. The annotation and message preview files had no findings. The
other files had seven weak or misdirected items and four unstated
assertions, all fixed before the BDD files were removed:

- The artifact viewer opens each private attachment from its own preview
  link and asserts the formatted update time. It checks the frame
  absence after the visible thumbnail proves the screenshot load was
  handled.
- After Drive scope recovery is dismissed, the test waits for the app to
  close the authorization window before checking that the upload does
  not resume. Closing the preview aborts completion polling.
- After a pending Drive setup is cancelled, the test waits for the
  client to abort its upload before releasing the late response and
  checking that no success message appears.
- The unstated composer mark count, Drive upload mode, connection and
  repeated replay count were removed.

## Upstream

No retained upstream additions belong to these files. The Drive file has
four prior upstream rows marked `review-prior-upstream-or-remapped` in
the [`eaae30ac` ledger](test-rebuild-upstream-eaae30ac-scenarios.tsv):
the Drive and Docs view links and the Sheets and Slides editor links.
They stay in the global review queue and are not registered.

## CI on `475ced66`

The lower-case title now passes `Pull Request Title`, and
`ci-gate-security` passes. All 8 `test-app` shards passed, taking 1m04s,
1m22s, 1m21s, 1m22s, 1m24s, 1m19s, 1m05s and 1m22s. `lint-eslint` and
`lint-knip` still fail on temporary BDD Markdown and helpers whose tests
are not rebuilt yet, and `ci-gate-turbo` reports those two results. They
remain close-out items.

## Review questions for Ethan

- `chat-navigation-artifact-sidebar-002` and `-003` check the Office
  viewer frame is keyboard-focusable through its tab index and a
  programmatic focus, because the test environment cannot tab into an
  iframe.
- `chat-attachment-annotation-017` represents a previously previewed
  public image by opening its preview first and requiring the annotation
  read to bypass the browser cache, as the baseline did.
- `chat-attachment-annotation-015` asserts at least one read of the
  public image URL. The BDD does not say the read happens exactly once.

Next, continue with the remaining `okou-page` chat files, which hold 327
of the 435 remaining files.
