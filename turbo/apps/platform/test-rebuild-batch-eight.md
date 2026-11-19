# App rebuild chat message, resources and continuity batch

All 65 accepted files register 274 frozen executions and 3 selected
upstream additions, and all 277 pass. Their frozen baseline is 508
executions, so the verified reduction is 234 (46.1%). The final 30% gate
still uses the complete suite's actual registered count.

| Scope                      | Files | Frozen executions | Registered and passed |
| -------------------------- | ----: | ----------------: | --------------------: |
| Rebuilt in this batch      |    15 |                89 |                    48 |
| All accepted files         |    65 |               508 |                   274 |
| Remaining frozen BDD scope |   420 |             4,603 |   2,407 still to keep |

| File                                   | Frozen executions | Registered and passed |
| -------------------------------------- | ----------------: | --------------------: |
| Chat message visualization preferences |                 1 |                     1 |
| Chat message history                   |                 3 |                     2 |
| Chat message plain text links          |                 5 |                     3 |
| Chat message follow-ups                |                 8 |                     4 |
| Chat message structured content        |                10 |                     5 |
| Chat resources navigation              |                 4 |                     2 |
| Chat resources layout                  |                 6 |                     3 |
| Chat resources realtime                |                 5 |                     3 |
| Chat resources                         |                 9 |                     5 |
| Chat continuity draft recovery         |                 2 |                     1 |
| Chat continuity keyboard               |                 4 |                     2 |
| Chat continuity clipboard              |                 5 |                     3 |
| Chat continuity history                |                 6 |                     3 |
| Chat continuity drafts                 |                 7 |                     4 |
| Chat continuity uploads                |                14 |                     7 |

The [execution ledger](test-rebuild-rebuilt-executions.tsv) and the
[GWT checklist](test-rebuild-gwt-checklist.tsv) cover all 277 registered
IDs, including 1,206 Then items. Runtime rows, static declarations and
ledger rows match in both directions.

## Independent audit

Three read-only auditors mapped each file against its frozen BDD before
acceptance. Every registration matched one selected ID. They found 14
weak Then assertions and 2 unstated assertions, all fixed before the BDD
files were removed:

- Visualization preferences assert each summary's exact displayed text
  and find the summary by role instead of unstated accessible names.
- The named MCP source is checked for links anywhere in its message.
- The chat rename shortcut checks wait until the newer chat is loaded
  and a typed character proves the shortcuts were handled.
- The resources realtime and reopen checks settle on recorded catalog
  reads, and the transcript reference is asserted as a link.
- Multipart uploads assert exactly four initial parts, and the restored
  rich draft keeps its feedback note as well as its quote.
- An unstated draft-save assertion became a non-asserting readiness wait.

`chat-resources-realtime-005` follows its recorded upstream change in
[`03698f76`](test-rebuild-upstream-03698f76.tsv) row 4: the open
resources popover also shows the published video. Those two items are
marked upstream-amended.

## Not started

`chat-message-pdf` and `chat-resources-catalog` were left for a later
batch with no partial files. `chat-message-pdf-001` was changed upstream,
`upstream-eaae30ac-chat-message-pdf-132-02` is retained and three
`178` rows need review. `chat-resources-catalog-001` was changed
upstream, and `upstream-48933-artifact-gallery-independent-paging` is
retained. `upstream-48933-artifact-gallery-refresh-recovery` is retained
for the realtime file and is not yet registered.

## Review questions for Ethan

- `chat-resources-realtime-004` and `chat-resources-002` assert catalog
  read counts to prove a notification or reopen caused no refresh. Page
  tests normally avoid counting requests.
- `chat-continuity-drafts-002` checks that the older draft is not shown
  after the delayed draft response is sent, with no visible sign that
  the client processed it, as in the baseline.
- `chat-message-followups-004` checks the selected prompt text with
  `window.getSelection()`, as the baseline did.

Next, finish `chat-message-pdf`, `chat-resources-catalog` and the
retained `upstream-48933` additions, then continue with the
`chat-composer` family (40 files, 198 executions to keep).
