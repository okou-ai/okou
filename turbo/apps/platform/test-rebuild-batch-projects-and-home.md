# Projects, billing and home surfaces rebuild

The batch uses the production Router with local Clerk, HTTP, realtime and
browser fixtures. The execution ledgers and
[GWT checklist volume 4](test-rebuild-gwt-checklist-4.tsv) record the accepted
expansion of each selected scenario.

## Source revision

Each file is restored from current `main`, not the frozen baseline. The
selection maps every frozen ID to its baseline registration and then, by
title, to the same registration on `main`. Every parameter array must be
unchanged. Registrations on `main` that are absent from the baseline are kept
only when an upstream ledger retains them.

Upstream `71af7ce1` (#48925) made Project fold dependencies asynchronous. The
`main` versions of `project-chat-list`, `sidebar-virtualization` and
`projects` wrap fold toggles in `act` or wait for the observable expanded
state. The [dd337098 ledger](test-rebuild-upstream-sync-dd337098.md) records
these as timing-only changes with the same Given/When/Then.

## Deferred files from the workspace sidebar batch

The [workspace sidebar batch](test-rebuild-batch-workspace-sidebar.md)
deferred four files. All four are now accepted.

| File                     | Earlier result                                  | Resolution                                                                                                                                          |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org-members-tab`        | `006` timed out at 5 s                          | Load-induced. Alone it passes 15 of 15, with `006` at 0.7 s. Final runs use one worker.                                                             |
| `sidebar-chat-history`   | `005` timed out at 5 s                          | Load-induced. Alone it passes 15 of 15, with `005` at 0.4 s. The retained upstream `upstream-471ba7ee-sidebar-chat-history-1267-01` joins the file. |
| `project-chat-list`      | `011` saw `aria-expanded="false"` after a click | The baseline body asserted synchronously. The `main` body waits for the expanded and collapsed states.                                              |
| `sidebar-virtualization` | Ten rows timed out or saw the pre-click state   | The baseline body clicked outside `act`. The `main` body settles each fold toggle inside `act` before the frame fixture advances.                   |

The earlier diagnostic first run executed 20 files together while type
checking ran. This machine has two CPUs and 3 GB of memory. Final acceptance
runs use `--maxWorkers=1`.

## Given/When/Then adjustments

An independent review checked every selected item against the test body in
both directions. Where a stated Then was not asserted, the rebuilt case now
asserts it. No case was added.

| ID                              | Part  | Change                                                                                      |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `projects-043`                  | Then  | The message is asserted after the Campaign change as well as after Launch.                  |
| `org-billing-tab-006`           | Then  | Upgrade to Team is re-checked as enabled after the package changes.                         |
| `sidebar-virtualization-018`    | Then  | The 68-row budget is also checked at History 10000 and back at the top.                     |
| `thread-mail-004`               | When  | After All, the case closes Emails and reopens the chat-opened draft without Back to emails. |
| `thread-mail-013`               | Then  | Send stays disabled after Forward as well as after Back.                                    |
| `my-okou-001`                   | Then  | The guidance and My Okou settings are re-checked after the save.                            |
| `agent-chat-tagline-001`        | Given | The reduced-motion media query matches instead of every query being false.                  |
| `agent-chat-avatar-texture-005` | Then  | The default artwork URL is absent from the avatar frame.                                    |
| `feature-guides-003`            | Then  | The first walkthrough step remains after swiping Next.                                      |
| `feature-guides-004`            | Then  | The video keeps its controls after the swipe on it.                                         |
| `growth-entry-002`              | Then  | Settings shows the 1,600 usage-pack credits.                                                |

These items are covered as written. The checklist notes record why.

- `thread-mail-003` repeats Select all before switching to Sent. The Sent
  filter has no checkboxes, so it cannot be repeated there.
- `projects-046` asserts Send is disabled before confirmation. A disabled
  control cannot submit.
- `org-billing-tab-001` and `002` open the iOS billing management link. No
  platform emulation is involved.
- `org-billing-tab-023` arranges the period-end Team-to-Pro change in the
  review flow. Nothing is scheduled at the start.
- `project-chat-list-007` opens a chat that belongs to another Agent's list.
  Its selection is observed through the unchanged chat route.
- `sidebar-virtualization-019` checks the chat-list region's scroll viewport.

Two comments that described unselected cases were removed from
`sidebar-chat-history` and `projects`. One `org-billing-tab` parameter list
keeps its original union type through an explicit type argument.

## Accepted files

The first batch accepted 127 of 248 frozen rows and one upstream row across
ten files: `org-members-tab`, `sidebar-chat-history`, `project-chat-list`,
`sidebar-virtualization`, `projects`, `org-billing-tab`, `thread-mail`,
`workflow-queue`, `my-okou` and `agent-instructions`. It passed targeted
Vitest, Platform test TypeScript, ESLint and both Oxlint configurations before
BDD removal.

The second batch accepted 33 of 63 frozen rows across ten files:
`ideas-page`, `feature-guides`, `growth-entry`, `initial-locale`,
`localization`, `agent-chat-tagline`, `agent-chat-avatar-texture`,
`debug-learning`, `debug-morning-brief` and `debug-openrouter-preset`. It
passed the same checks before BDD removal.

`chat-scroll` and `unified-chat-workspace` were not selected for this round.
`chat-scroll` already has accepted rows in the branch, and
`unified-chat-workspace-001` was renamed upstream. Both keep their BDD.

## Lint repair in earlier rebuilt files

Whole-app Oxlint reported 23 errors and 5 warnings in eight files accepted
in earlier batches. Seven browser-session files and `agent-suggestions` now
use `toStrictEqual`, `await expect(...).resolves`, numeric separators and
`dataset`. Expectations no longer sit in test conditionals. The stalled RTT
probe case asserts its single version request directly. The eight files pass
70 of 70 Vitest rows, and both whole-app Oxlint configurations pass.
Registration lines that moved are updated in the ledgers. Two
`agent-suggestions` upstream rows had stale lines from an earlier batch.
They now point at their registrations.

`eslint .` still reports a parse error for every temporary BDD file under
`src/views` and `src/signals`. The configuration generated from the Oxlint
overrides matches `src/views/**/*.*` and `src/signals/**/*.*`. Those parse
errors were the only ESLint findings. They clear when the remaining BDD files
are removed, without a lint configuration change.

## Activity and Agents pages

The third batch accepted 28 of 48 frozen rows across ten files:
`activity-capture-actions`, `activity-detail-retained-data`,
`activity-inspect-page`, `activity-log`, `activity-network-filter`,
`activity-paged-events`, `activity-runner-attribution`, `agents-page`,
`agents-page-avatar-framing` and `agents-management`.

The review found one premise gap. The `activity-log-001` row for the old
response shape still received the newer `failureReason` field from the shared
detail fixture. The row now omits it. `activity-log-009` now rejects the
event type and the token count anywhere in the page text, including formatted
digits. The other items are covered as written, with notes in the checklist.
