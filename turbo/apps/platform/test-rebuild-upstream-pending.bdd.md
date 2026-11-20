# Pending upstream scenarios

These retained upstream scenarios lost their test file when copied test bodies
were removed. Each section is restored verbatim from the BDD or checklist that
recorded it; the source commit is noted. Rebuild them from these scenarios.

## upstream-471ba7ee-sidebar-chat-history-1267-01

The Okou rail entry opens My Okou's chat page at /. [Registration](https://github.com/okou-ai/okou/blob/471ba7ee/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1267).

- **Given** My Okou and the Okou rail entry are enabled, and the user is viewing an existing conversation.
- **When** The user selects the Okou entry in the navigation rail.
- **Then** The rail shows an Okou link to `/` and no separate Chat entry. Selecting it opens `/`, where New chat is the current page in the sidebar.
- **Disposition** retain; rebuild with `sidebar-chat-history`.
- **Source** `test-rebuild-upstream-471ba7ee.bdd.md` at `d576761e`.

## upstream-eaae30ac-chat-run-artifact-carryover-135-01

Show format download items and report conversion failures in a toast. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L135).

- **Given** A Markdown output offers multiple download formats and conversion fails.
- **When** Open the download menu and choose an export format.
- **Then** The format actions are available and a failed conversion reports an error in a toast.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `1aeb21ec`.

## upstream-eaae30ac-settings-refresh-state-109-01

overlapping saves preserve each confirmed preference. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L109).

- **Given** Two different preference writes can overlap.
- **When** Change two preferences while the first response is pending.
- **Then** The resulting controls show both confirmed choices.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `de86cf85`.

## upstream-eaae30ac-preferences-page-221-01

Appearance choices made during startup survive the initial workspace read. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L221).

- **Given** The workspace's appearance read is still pending.
- **When** Change appearance and allow the initial read to finish.
- **Then** The completed startup does not overwrite the choices made while it was pending.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `8c982246`.

## upstream-eaae30ac-directed-connect-page-924-01

Continue from an existing connector authorization link using the saved account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L924).

- **Given** A connector has an available saved account and the chat has a directed authorization link.
- **When** Open the link through the real router and choose the saved account.
- **Then** The current connect page continues the originating chat with the selected account.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `e882b1cd`.

## upstream-eaae30ac-chat-thread-sidebar-resize-161-01

Each panel kind opens at its own width and keeps its own resize. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L161).

- **Given** A thread can open more than one type of side panel.
- **When** Open each panel and resize one of them.
- **Then** Each panel starts at its own width and remembers its own resize.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `9535dfab`.

## upstream-eaae30ac-markdown-docx-21-01

markdown DOCX export > creates a Word package with headings, emphasis, tables, and safe links. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L21).

- **Given** An exportable Markdown result contains headings, emphasis, a table and a link.
- **When** Export the result as DOCX.
- **Then** The Word package retains the heading, emphasis and table, and contains the safe hyperlink.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `cdc9484a`.

## upstream-eaae30ac-markdown-docx-51-01

markdown DOCX export > fits wide CJK tables to a landscape page with content-sized columns. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L51).

- **Given** A Markdown result contains a wide table with CJK text.
- **When** Export the table to Word.
- **Then** The document uses a landscape section with columns sized to its content.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `cdc9484a`.

## upstream-eaae30ac-markdown-docx-132-01

markdown DOCX export > exports native bookmarks, footnotes, equations, and task states. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L132).

- **Given** The result contains bookmarks, notes, math and task items.
- **When** Export the Markdown to Word.
- **Then** The resulting document contains native bookmarks, footnotes, equations and task state.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `cdc9484a`.

## upstream-48933-artifact-gallery-independent-paging

[Registration](https://github.com/okou-ai/okou/blob/03698f76c291f312c82beb556ff7f6e32ef8369d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L306).

- **Given** A chat has 65 artifacts and the open resource popover shows the first page.
- **When** The user presses Show more twice to reach report 65, opens report 1, and returns to all artifacts from its preview.
- **Then** The sidebar gallery opens on its own first page and shows Artifacts 60+. Report 65 is absent from that page despite being loaded in the popover.
- **Source** `chat-artifact-catalog.upstream.bdd.md` at `83baa182`.

## upstream-48933-artifact-gallery-refresh-recovery

[Registration](https://github.com/okou-ai/okou/blob/03698f76c291f312c82beb556ff7f6e32ef8369d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L121).

- **Given** A chat's artifact gallery is open and shows report.pdf.
- **When** A catalog-change notification triggers a refresh that fails, and the user opens the resources popover after service recovers.
- **Then** The gallery first says “Couldn't load artifacts.” After the popover opens, both the resources and the already-open gallery display report.pdf.
- **Source** `chat-artifact-catalog.upstream.bdd.md` at `83baa182`.

## upstream-eaae30ac-chat-message-pdf-132-02

Offer a native PDF download whose bytes survive repeated clicks on pr-1-app.omby.ai. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L132).

- **Given** A completed chat result is exportable on the device in this example.
- **When** Export as PDF and click the resulting download twice.
- **Then** Both downloads expose the same generated PDF bytes through a native download.
- **Disposition** retain.
- **Source** `test-rebuild-upstream-eaae30ac.bdd.md` at `a8cb0eab`.

## upstream-48919-artifact-toolbar-dialog-ungrouped

- **Given** An artifact preview is available in the dialog with action grouping disabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** Download precedes the vertical separator, Enter fullscreen follows the separator, and Close follows Enter fullscreen.
- **Source** `chat-artifact-action-group.upstream.bdd.md` at `38201c80`.

## upstream-48919-artifact-toolbar-sidebar-grouped

- **Given** An artifact preview is available in the sidebar with action grouping enabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** More artifact actions precedes the vertical separator, Enter fullscreen follows the separator, and Close artifact follows Enter fullscreen.
- **Source** `chat-artifact-action-group.upstream.bdd.md` at `38201c80`.

## upstream-e0e20862-project-deletion-212-01

Project deletion confirmation includes every archived page and returns safely to choices. [Registration](https://github.com/okou-ai/okou/blob/e0e20862/turbo/apps/platform/src/views/okou-page/__tests__/project-deletion.test.tsx#L212).

- **Given** My Okou and Project thread deletion are enabled. The Project "Launch" has 101 member chats, alternately archived, spanning more than one page of the member list. The user is viewing an unrelated chat.
- **When** The user opens Delete from the Project's options, chooses to delete the Project and its 101 threads, then selects Back and presses Escape.
- **Then** The choice names all 101 threads. The confirmation lists members from every page, including archived ones, warns that this cannot be undone and focuses Back. Back returns focus to the delete-all choice. Escape closes the choices and returns focus to the Project's options; the Project stays in the sidebar and the user stays on the same chat.
- **Disposition** retain (#49121).
- **Source** `test-rebuild-gwt-checklist.tsv` at `4855592c`.

## upstream-e0e20862-project-deletion-303-01

A new Project member requires reviewing the changed list before deleting anything. [Registration](https://github.com/okou-ai/okou/blob/e0e20862/turbo/apps/platform/src/views/okou-page/__tests__/project-deletion.test.tsx#L303).

- **Given** The Project has one member chat when the user opens the full-deletion confirmation, and a second member joins before they confirm.
- **When** The user confirms Permanently delete, then confirms again after the review prompt.
- **Then** The first confirmation describes deleting the Project and 1 thread. Confirming asks the user to review the updated list without deleting any chat, and the list now shows both members and describes 2 threads. Confirming again deletes the Project, removes it from the sidebar and moves focus to Create Project.
- **Disposition** retain (#49121).
- **Source** `test-rebuild-gwt-checklist.tsv` at `4855592c`.

## upstream-e0e20862-project-deletion-363-01

Deleting the open Project thread finishes the batch before navigating to a new chat. [Registration](https://github.com/okou-ai/okou/blob/e0e20862/turbo/apps/platform/src/views/okou-page/__tests__/project-deletion.test.tsx#L363).

- **Given** The Project has three member chats, the user is viewing the first of them, and the chat deletions respond only after a delay.
- **When** The user confirms deleting the Project and its 3 threads, presses Escape while deletion is running, then the deletions complete.
- **Then** While deleting, the confirm action shows Deleting… and is disabled, Back is disabled, Escape does not close the confirmation and the user stays on the open chat. After every member chat and the Project are deleted, the app opens `/` with the message composer, and the Project no longer appears in the sidebar.
- **Disposition** retain (#49121).
- **Source** `test-rebuild-gwt-checklist.tsv` at `4855592c`.

## upstream-25d468f6-onboarding-progress-01

Another member's saved task and step survive editing on a shared browser. [Registration](https://github.com/okou-ai/okou/blob/25d468f6/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx).

- **Given** Onboarding is incomplete, the server draft is unavailable, and the browser holds saved task and step progress from another member of the organization.
- **When** The current member opens the ready step and types "Summarize this week's work".
- **Then** The task field shows the new text, and the other member's saved task and step stay unchanged in browser storage.
- **Disposition** retain; added by #49384, which retired `onboarding-progress-005`.
- **Source** written from the main registration at `25d468f6`.

## upstream-ae05e279-chat-message-pdf-370-01

Exported file cards retain their labels and durable links on a download-restricted workspace. [Registration](https://github.com/okou-ai/okou/blob/ae05e279c6158a6e3d014dfdaafcdf539f0e9ffe/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L370).

- **Given** A completed chat answer embeds a workbook file card with alt text, a CSV file card without alt text, and a workbook card linked to an external guide, in a workspace where artifact downloads are not allowed.
- **When** The user exports the answer as PDF.
- **Then** The PDF text includes the answer, "Budget workbook", "totals.csv", "Read the guide" and "End of answer.", and its links point to the durable artifact URLs of both files and to the guide.
- **Disposition** retain.
- **Source** upstream `ae05e279` (#49389), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-330-03

Default configuration profile opens personal Instructions with Suggestions set to true. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L330).

- **Given** Single-agent mode and Suggestions are enabled, and the user has personal Instructions.
- **When** The user opens the default agent's profile tab.
- **Then** The app moves to My Okou settings at the home page and the Instructions editor shows the personal Instructions.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed. The rows with Suggestions off match the frozen scenarios of this registration. Renamed and regated by `1d42e699` (#49439).

## upstream-9d20531a-my-okou-330-04

Default configuration instructions opens personal Instructions with Suggestions set to true. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L330).

- **Given** Single-agent mode and Suggestions are enabled, and the user has personal Instructions.
- **When** The user opens the default agent's instructions tab.
- **Then** The app moves to My Okou settings at the home page and the Instructions editor shows the personal Instructions.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-402-01

An Instructions link opens its editor and a later ordinary visit starts on Proactive. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L402).

- **Given** Suggestions are enabled, so My Okou shows the Proactive layout, and the user follows a My Okou link focused on Instructions.
- **When** The user reads the Instructions, goes to Chat, reopens My Okou, switches to Instructions, and closes Settings.
- **Then** The link opens the Instructions tab with the saved text. The later ordinary visit starts on Proactive, switching to Instructions focuses that tab in the address, and closing Settings removes the dialog and the focus.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-435-01

My Okou opens Proactive first, unifies legacy Suggestions choices, and retains an Instructions draft across tabs. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L435).

- **Given** Suggestions are enabled, so My Okou shows the Proactive layout; new suggestion cards are on and hourly checks are off.
- **When** The user turns both Suggestions settings off, turns Suggestions back on, turns Offers off, and drafts new Instructions before switching tabs.
- **Then** Proactive opens first and explains the mixed Suggestions state; after the choice, one Suggestions switch reflects both settings while Learning, Offers and System updates keep their own states. The Proactive and Instructions tabs keep the Suggestions choice and the Instructions draft across switches.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-501-01

A member with only hourly checks can opt into new cards without showing a stale mixed state during refresh. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L501).

- **Given** Hourly checks are on and new suggestion cards are off, and the next feed-source refresh is delayed.
- **When** The user chooses to turn both Suggestions settings on.
- **Then** The mixed state is explained first; while the refresh is pending, the single Suggestions switch is shown on and unavailable, and it becomes available once the refresh completes.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-552-01

Existing morning brief links open the Proactive tab in My Okou. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L552).

- **Given** Suggestions are enabled and the user follows an existing Preference link focused on the morning brief.
- **When** The settings open, and the user then switches to Preference.
- **Then** The Proactive tab of My Okou shows an enabled Morning brief switch; Preference shows Appearance without the morning brief, and the focus is removed from the address.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-agent-suggestions-1734-01

For you keeps deck navigation and moves source settings into My Okou. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1734).

- **Given** Single-agent mode and Suggestions are enabled and the For You deck has two suggestions.
- **When** The user opens For You and moves to the second suggestion.
- **Then** For You no longer offers its own source settings, and the second suggestion becomes the active, current step.
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401); the rebuilt suggestion tests are kept and this scenario is pending its rebuild.

## upstream-1d42e699-my-okou-569-01

The morning brief link opens Preference when the Suggestions feature switch is off. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L569).

- **Given** Single-agent mode is enabled and Suggestions are disabled.
- **When** The user follows an existing Preference link focused on the morning brief.
- **Then** Settings opens on Preference and shows an enabled Morning brief switch.
- **Disposition** retain.
- **Source** upstream `1d42e699` (#49439), added to the copied test file after it was removed.
