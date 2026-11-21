# Pending upstream scenarios

These retained upstream scenarios lost their test file when copied test bodies
were removed. Sections preserve their original stable IDs and cite the BDD, checklist or registration that records the behavior. Rebuild them from these scenarios.

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
- **Upstream update** #49642 (`6164b16820`) waits for the conversion error inside Notifications, then checks that the same toast is unique on the page.

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
- **Upstream change** `81238fbf` (#49446) maps the top-level Markdown heading to the Word Title style instead of Heading 1 ([Registration](https://github.com/okou-ai/okou/blob/81238fbf702ef4d41198ed807ab1139e3a0e14e4/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L21)).
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
- **Then** The choice names all 101 threads. The confirmation lists members from every page, including archived ones, warns that this cannot be undone and focuses Back. Back dismisses the confirmation. Escape closes the choices; the Project stays in the sidebar and the user stays on the same chat.
- **Disposition** retain (#49121). [#49593](https://github.com/okou-ai/okou/pull/49593) changed the final observation to dialog dismissal.
- **Source** `test-rebuild-gwt-checklist.tsv` at `4855592c`.

## upstream-e0e20862-project-deletion-303-01

A new Project member requires reviewing the changed list before deleting anything. [Registration](https://github.com/okou-ai/okou/blob/e0e20862/turbo/apps/platform/src/views/okou-page/__tests__/project-deletion.test.tsx#L303).

- **Given** The Project has one member chat when the user opens the full-deletion confirmation, and a second member joins before they confirm.
- **When** The user confirms Permanently delete, then confirms again after the review prompt.
- **Then** The first confirmation describes deleting the Project and 1 thread. Confirming asks the user to review the updated list without deleting any chat, and the list now shows both members and describes 2 threads. Confirming again deletes the Project, removes it from the sidebar and closes the deletion dialog.
- **Disposition** retain (#49121). [#49593](https://github.com/okou-ai/okou/pull/49593) changed the final observation to dialog dismissal.
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
- **Then** Proactive opens first and explains the mixed Suggestions state; after the choice, one Suggestions switch reflects both settings while Offers and System updates keep their own states. The Proactive and Instructions tabs keep the Suggestions choice and the Instructions draft across switches.
- **Upstream change** `ec5330db` (#49438) removes the Learning switch, so it no longer appears in Proactive, and changes the mixed-state explanation to “New cards are on. Hourly checks and daily profile updates are off. Choose one setting for both.” ([Registration](https://github.com/okou-ai/okou/blob/ec5330dbee67ad46e9dee4e000ba92863b223681/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L434)).
- **Disposition** retain.
- **Source** upstream `9d20531a` (#49401), added to the copied test file after it was removed.

## upstream-9d20531a-my-okou-501-01

A member with only hourly checks can opt into new cards without showing a stale mixed state during refresh. [Registration](https://github.com/okou-ai/okou/blob/1d42e6994ad6d82a6678d34b955335765fc560b5/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L501).

- **Given** Hourly checks are on and new suggestion cards are off, and the next feed-source refresh is delayed.
- **When** The user chooses to turn both Suggestions settings on.
- **Then** The mixed state is explained first; while the refresh is pending, the single Suggestions switch is shown on and unavailable, and it becomes available once the refresh completes.
- **Upstream change** `ec5330db` (#49438) changes the mixed-state explanation to “Hourly checks and daily profile updates are on. New cards are off. Choose one setting for both.” ([Registration](https://github.com/okou-ai/okou/blob/ec5330dbee67ad46e9dee4e000ba92863b223681/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L497)).
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

## upstream-18c9913d-document-export-worker-93-01

Classifies synchronous Worker bootstrap failure without retaining its message. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L93).

- **Given** The document export Worker cannot be constructed.
- **When** The user exports a document.
- **Then** The export fails in the bootstrap phase with a message that omits the original error, and no Worker remains.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-108-01

Classifies pre-ready and post-ready Worker errors separately. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L108).

- **Given** One export Worker fails before reporting ready and another fails after it.
- **When** The user runs both exports.
- **Then** The first export fails in the bootstrap phase and the second as a native Worker error; each Worker is terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-132-01

Classifies a synchronous postMessage failure without retaining its message. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L132).

- **Given** Sending the export request to the Worker throws synchronously.
- **When** The user exports a document.
- **Then** The export fails in the message decoding phase without retaining the original message, and the Worker is terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-145-01

Classifies message decoding and controlled rendering failures safely. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L145).

- **Given** One Worker replies with a malformed message, one cannot decode its reply, and one rejects rendering for a document with private content.
- **When** The user runs the exports.
- **Then** Malformed and undecodable replies fail in the message decoding phase and the rendering rejection fails as such; no error exposes the private document content, and each Worker is terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-199-01

Preserves the successful pdf export response and request. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L199).

- **Given** The export Worker renders a PDF successfully.
- **When** The user exports the document as PDF.
- **Then** The Worker receives the original request and the export resolves with the generated file; the Worker is then terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-199-02

Preserves the successful docx export response and request. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L199).

- **Given** The export Worker renders a DOCX file successfully.
- **When** The user exports the document as DOCX.
- **Then** The Worker receives the original request and the export resolves with the generated file; the Worker is then terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-18c9913d-document-export-worker-219-01

Keeps cancellation owned by the caller and terminates only once. [Registration](https://github.com/okou-ai/okou/blob/18c9913d10396c7e27679fecbb96aba52a7f80de/turbo/apps/platform/src/lib/__tests__/document-export-worker.test.ts#L219).

- **Given** A document export is running in a Worker.
- **When** The caller cancels the export.
- **Then** The export is rejected as aborted and the Worker is terminated.
- **Disposition** review.
- **Source** upstream `18c9913d` (#49388), a Worker-client test that does not enter through a page. It was removed with the other non-page tests; rebuild it through a page-visible or external contract, or retire it per "Cases Without Public Construction".

## upstream-23cd576d-project-cache-89-01

Projects catch changes made while a cached page waits for realtime. [Registration](https://github.com/okou-ai/okou/blob/23cd576df69210cb535f8f819e27906c36d57dc6/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L89).

- **Given** A workspace was visited before, so a new page starts from cached Projects, and its realtime connection is still being established.
- **When** A project is renamed to "Launch ready" while the connection is pending, and the connection then completes.
- **Then** The page first shows the cached "Launch" project and, once realtime attaches, catches up and shows "Launch ready".
- **Disposition** retain.
- **Source** upstream `23cd576d` (#49440), added to the copied test file after it was removed.

## upstream-ad72ee86-chat-sharing-277-01

The selection column toggles a message group once. [Registration](https://github.com/okou-ai/okou/blob/ad72ee8660d9450fa57e8df86389fe30c1e9abae/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L277).

- **Given** Refined message sharing is enabled and a chat is in sharing mode.
- **When** The user selects a message group from its selection column and then deselects it.
- **Then** Exactly one message group is selected, and deselecting it leaves no group selected.
- **Disposition** retain.
- **Source** upstream `ad72ee86` (#49038) for the `ChatShareRefresh` design. The rebuilt chat-sharing tests cover the default design and stay as rebuilt.

## upstream-ad72ee86-chat-sharing-298-01

Select all, clear all, and individual selection use the same message groups. [Registration](https://github.com/okou-ai/okou/blob/ad72ee8660d9450fa57e8df86389fe30c1e9abae/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L298).

- **Given** Refined message sharing is enabled for a chat with a prompt group and an answer group.
- **When** The user selects all, deselects all, selects the prompt individually, selects all again, deselects the answer, selects all once more, and creates a link.
- **Then** Select all and individual choices act on the same groups: both are checked after Select all, both clear after Deselect all, and Select all becomes available again after one group is deselected. The link is created from the full selection.
- **Disposition** retain.
- **Source** upstream `ad72ee86` (#49038) for the `ChatShareRefresh` design. The rebuilt chat-sharing tests cover the default design and stay as rebuilt.

## upstream-ad72ee86-chat-sharing-700-01

Select all includes the complete transcript after selected messages move outside the render window. [Registration](https://github.com/okou-ai/okou/blob/ad72ee8660d9450fa57e8df86389fe30c1e9abae/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L700).

- **Given** Refined message sharing is enabled and a selected answer later moves outside the rendered window as new turns arrive.
- **When** The user selects all and shares.
- **Then** The selection count reflects the whole transcript and the shared snapshot includes every message group, including those outside the render window.
- **Disposition** retain.
- **Source** upstream `ad72ee86` (#49038) for the `ChatShareRefresh` design. The rebuilt chat-sharing tests cover the default design and stay as rebuilt.

## upstream-ad72ee86-chat-sharing-974-01

An oversized Select all leaves the existing selection intact. [Registration](https://github.com/okou-ai/okou/blob/ad72ee8660d9450fa57e8df86389fe30c1e9abae/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L974).

- **Given** Refined message sharing is enabled, one message is selected, and selecting every group would exceed the shareable size.
- **When** The user chooses Select all.
- **Then** The oversized selection is rejected with an explanation and the existing selection stays unchanged.
- **Disposition** retain.
- **Source** upstream `ad72ee86` (#49038) for the `ChatShareRefresh` design. The rebuilt chat-sharing tests cover the default design and stay as rebuilt.

## upstream-ad72ee86-chat-sharing-1349-01

Without the refreshed design, sharing keeps the legacy footer and copy toast. [Registration](https://github.com/okou-ai/okou/blob/ad72ee8660d9450fa57e8df86389fe30c1e9abae/turbo/apps/platform/src/views/okou-page/__tests__/chat-sharing.test.tsx#L1349).

- **Given** Refined message sharing is disabled.
- **When** The user enters sharing mode, selects one message group, and shares it.
- **Then** The legacy footer counts "0 selected" then "1 selected" without Select all; sharing shows the link in a "Shared chat link" field, copies it to the clipboard, and confirms "Link copied".
- **Disposition** retain.
- **Source** upstream `ad72ee86` (#49038) for the `ChatShareRefresh` design. The rebuilt chat-sharing tests cover the default design and stay as rebuilt.

## upstream-4411c561-lab-page-116-02

Staff see Markdown document typography enabled by default in Beta. [Registration](https://github.com/okou-ai/okou/blob/4411c561192e7c85a6c8ecf89b9578c05f9c7f66/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L116).

- **Given** A staff member opens Lab with no explicit Markdown document typography setting.
- **When** The feature list loads.
- **Then** Markdown document typography appears in Beta and is enabled by default.
- **Disposition** review.
- **Source** upstream `4411c561` (#49461), a new row of the frozen `lab-page-003` test in the copied test file after it was removed. `lab-page-003` is not selected.

## upstream-4411c561-lab-page-144-02

External peers cannot opt into Markdown document typography in Lab. [Registration](https://github.com/okou-ai/okou/blob/4411c561192e7c85a6c8ecf89b9578c05f9c7f66/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L144).

- **Given** An external peer opens Lab with the Lab and Markdown document typography switches enabled.
- **When** The feature list loads.
- **Then** Banking is listed, but Markdown document typography is not available.
- **Disposition** review.
- **Source** upstream `4411c561` (#49461), a new row of the frozen `lab-page-004` test in the copied test file after it was removed. `lab-page-004` is not selected.

## upstream-81238fbf-chat-run-artifact-carryover-200-01

Download a Word export with document title styles without changing Markdown headings. [Registration](https://github.com/okou-ai/okou/blob/81238fbf702ef4d41198ed807ab1139e3a0e14e4/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L200).

- **Given** A related Markdown artifact uses one to six heading levels, two top-level headings, internal heading links and a fenced Markdown heading.
- **When** The user opens it in the artifact preview, keeps its headings and downloads it as DOCX.
- **Then** The preview keeps each Markdown heading level, and the downloaded `summary.docx` uses the Word Title style for top-level headings, keeping their bold text, and Heading 1 to Heading 5 for the next levels, keeps heading links working and leaves the fenced heading as code.
- **Disposition** review.
- **Source** upstream `81238fbf` (#49446), which replaces `upstream-eaae30ac-chat-run-artifact-carryover-197-01` (resolved as not selected) in the copied test file after it was removed.

## upstream-818414b2-agent-suggestions-2327-01

The member picks a For you cover, keeps it after reload and can reset it. [Registration](https://github.com/okou-ai/okou/blob/818414b23d/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2327).

- **Given** For you shows suggestion cards under the default cover.
- **When** The member opens Change cover, picks another cover, reloads the page, then resets the cover and moves the selection with an arrow key.
- **Then** The picker marks the current cover and disables Reset while the default is selected; the picked cover replaces the banner and survives a reload in this browser; Reset restores the default; arrow keys move the selection in the radio gallery.
- **Upstream change** `b126e4ca` (#49508) drops Reset to default; the test is now `The member picks a For you cover, keeps it after reload and can return to the default` ([Registration](https://github.com/okou-ai/okou/blob/b126e4ca50/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2327)), which returns to the default by choosing Cover 1.
- **Disposition** retain.
- **Source** upstream `818414b2` (#49453), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-542-01

Upload another Chat's artifact from the dialog using the viewing Chat's Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L542).

- **Given** Two chats are open side by side; an artifact produced in the source chat has its own Drive account, and the viewing chat uses a different connected Drive account.
- **When** The member opens the source chat's artifact from the viewing chat's dialog and uploads it to Google Drive.
- **Then** The upload uses the viewing chat's Drive account and reports success there, without switching to the source chat's account.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-542-02

Upload another Chat's artifact from the sidebar using the viewing Chat's Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L542).

- **Given** Two chats are open side by side; an artifact produced in the source chat has its own Drive account, and the viewing chat uses a different connected Drive account.
- **When** The member opens the source chat's artifact from the viewing chat's sidebar and uploads it to Google Drive.
- **Then** The upload uses the viewing chat's Drive account and reports success there, without switching to the source chat's account.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-542-03

Upload another Chat's artifact from the dialog moved to sidebar using the viewing Chat's Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L542).

- **Given** Two chats are open side by side; an artifact produced in the source chat has its own Drive account, and the viewing chat uses a different connected Drive account.
- **When** The member opens the source chat's artifact from the viewing chat's dialog moved to sidebar and uploads it to Google Drive.
- **Then** The upload uses the viewing chat's Drive account and reports success there, without switching to the source chat's account.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-542-04

Upload another Chat's artifact from the existing sidebar using the viewing Chat's Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L542).

- **Given** Two chats are open side by side; an artifact produced in the source chat has its own Drive account, and the viewing chat uses a different connected Drive account.
- **When** The member opens the source chat's artifact from the viewing chat's existing sidebar and uploads it to Google Drive.
- **Then** The upload uses the viewing chat's Drive account and reports success there, without switching to the source chat's account.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-542-05

Upload another Chat's artifact from the card using the viewing Chat's Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L542).

- **Given** Two chats are open side by side; an artifact produced in the source chat has its own Drive account, and the viewing chat uses a different connected Drive account.
- **When** The member opens the source chat's artifact from the viewing chat's card and uploads it to Google Drive.
- **Then** The upload uses the viewing chat's Drive account and reports success there, without switching to the source chat's account.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-1066-01

Keep an artifact's Google editor link after uploading another artifact. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1066).

- **Given** Two artifacts in a chat can be uploaded to Google Docs.
- **When** The member uploads one artifact, then uploads the other while the artifact list is still waiting for its Drive status refresh.
- **Then** Each artifact keeps the Google editor link from its own upload response, and the first link is not lost when the second upload completes.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-1164-01

Keep the selected Drive account's editor link when an earlier account finishes uploading. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1164).

- **Given** An upload with an earlier Drive account is still in flight when the chat switches to another Drive account.
- **When** The member uploads with the newly selected account, then the earlier upload finishes.
- **Then** The preview keeps the editor link for the currently selected account and does not show the earlier account's file.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-1275-01

Keep the scope reconnect action when a previously started file upload completes. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1275).

- **Given** A Google Docs upload is accepted before Drive scope consent is withdrawn, and a later upload reports that Drive scope is required.
- **When** The member starts the second upload, then the earlier upload completes.
- **Then** The scope reconnect action stays available, while the completed upload's View it link and Open in Google Docs entry appear for its file.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-chat-navigation-artifact-drive-1537-01

Reconnect the same Drive account when refreshed status requires it. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1537).

- **Given** A chat's connected Drive account later reports that it needs reconnection.
- **When** The member opens the artifact menu after the refreshed status arrives and chooses Connect Google Drive.
- **Then** The connect flow reconnects the same account instead of adding a new one, and the earlier upload is not repeated.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-markdown-table-export-691-01

Offer Drive reconnection after closing the document preview that started the save. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L691).

- **Given** A Markdown document preview contains a table, and saving it to Google Drive will report that Drive needs reconnection.
- **When** The member starts a table save from the preview and closes the preview before the save finishes.
- **Then** The chat still offers Drive reconnection for the save after the preview has closed.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-markdown-table-export-799-01

Export a table from the right Chat's transcript to its Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L799).

- **Given** Two chats are open side by side, and the right chat has its own Drive account and a table in its transcript.
- **When** The member saves that table to Google Drive from the right chat's transcript.
- **Then** The save uses the right chat's Drive account and links the saved file there.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-markdown-table-export-799-02

Export a table from the right Chat's artifact sidebar to its Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L799).

- **Given** Two chats are open side by side, and the right chat has its own Drive account and a table in its artifact sidebar.
- **When** The member saves that table to Google Drive from the right chat's artifact sidebar.
- **Then** The save uses the right chat's Drive account and links the saved file there.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-markdown-table-export-799-03

Export a table from the right Chat's artifact dialog to its Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L799).

- **Given** Two chats are open side by side, and the right chat has its own Drive account and a table in its artifact dialog.
- **When** The member saves that table to Google Drive from the right chat's artifact dialog.
- **Then** The save uses the right chat's Drive account and links the saved file there.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-efa10f0b-markdown-table-export-799-04

Export a table from the right Chat's artifact card to its Drive account. [Registration](https://github.com/okou-ai/okou/blob/efa10f0bb9/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L799).

- **Given** Two chats are open side by side, and the right chat has its own Drive account and a table in its artifact card.
- **When** The member saves that table to Google Drive from the right chat's artifact card.
- **Then** The save uses the right chat's Drive account and links the saved file there.
- **Disposition** retain.
- **Source** upstream `efa10f0b` (#49430), added to the rebuilt test file.

## upstream-8343cc9e-custom-managed-default-reconnect-124-01

Reject a managed reconnect receipt whose account differs from the connector. [Registration](https://github.com/okou-ai/okou/blob/8343cc9e65/turbo/apps/platform/src/views/okou-page/__tests__/custom-managed-default-reconnect.test.tsx#L124).

- **Given** A Feishu managed connector is being reconnected, and the connector status reported after authorization names a different connected account than the reconnect receipt.
- **When** The member completes the reconnect authorization.
- **Then** The connection dialog stays open with a connector account identity mismatch error, and the only account change requested was the reconnect of the original connection.
- **Disposition** retain.
- **Source** upstream `8343cc9e` (#49530), added to the copied test file after it was removed.

## upstream-eaae30ac-agent-suggestions-2042-01

Don't nudge records the no-repeat direction and Undo targets that feedback. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions-deck.test.tsx#L483).

- **Given** Two suggestions are available in For you.
- **When** Choose Don’t nudge me on the first, then Undo its feedback confirmation.
- **Then** The next card appears. Undo restores the first card and targets its no-repeat feedback.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2273).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-a678cec8-agent-suggestions-1244-01

A custom direction continues the chat its card names without touching its saved draft. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1049).

- **Given** A For you suggestion names a chat that already has a saved draft as its custom-direction target (customOption.threadId).
- **When** The member opens the card direction editor, labelled “What do you have in mind?”, writes a direction and sends.
- **Then** One message goes to that chat with the suggestion and the direction. The saved draft is neither loaded into the card composer nor overwritten. For you advances after the send.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1292).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-e5077f39-agent-suggestions-1054-01

Selecting a suggested action switches away from the open custom composer. [Registration](https://github.com/okou-ai/okou/blob/e5077f3958/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1054).

- **Given** The current suggestion offers a prepared action and an inline custom composer with an unsent note.
- **When** The member chooses the prepared action on that card while the composer is open.
- **Then** The sent confirmation appears, the composer closes, the prepared message is sent in place of the typed note, and the card is consumed.
- **Disposition** New retained regression from #49618. The open, edited composer distinguishes it from frozen agent-suggestions-036 (choose a prepared action directly) and agent-suggestions-037 (send the custom direction). The former removable-quote scenario has its own historical ID and retirement in the withdrawal checkpoint.

## upstream-8ee03b20-agent-suggestions-1311-01

A custom direction continues a named chat missing from the chat list. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1145).

- **Given** Empty chat snapshot and named target metadata returns 200.
- **When** Write a direction in the card and send.
- **Then** Send the typed direction to the named chat without creating a new chat.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1347).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-8ee03b20-agent-suggestions-1401-01

A custom direction starts a new chat when its named chat is gone. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1184).

- **Given** Card names a missing target.
- **When** Write a direction in the card and send.
- **Then** Start a new chat and send the typed direction there.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1437).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-eaae30ac-chat-run-history-769-01

Show working dots on scroll-to-bottom while the thread works. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L609).

- **Given** A thread is producing output while the reader is above the end.
- **When** Open the thread while the run is active and view the scroll-to-bottom control.
- **Then** The scroll-to-bottom control indicates ongoing activity.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L772).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-eaae30ac-platform-feed-events-440-01

Enable keeps the update available after rejection and clears it after enabling the linked automation. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L452).

- **Given** A pause update links to a disabled automation and a sibling automation is already enabled.
- **When** The member enables the linked automation, receives a rejection, and retries.
- **Then** The first failure keeps the update actionable. During retry the card shows busy state and disables dismissal. Success clears the card after the exact linked automation is enabled and leaves the sibling enabled.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L440).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-eaae30ac-works-channel-status-15-01

Works distinguishes Feishu and Lark connection states on the same page. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L24).

- **Given** Works channel cards are on, Feishu is connected and Lark is disconnected.
- **When** Open Works and inspect both channel cards.
- **Then** Feishu shows Connected and links to Manage at /settings/feishu. Lark offers Connect at /settings/lark.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L15).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.

## upstream-eaae30ac-works-channel-status-41-01

Works recognizes an official Lark connection without a custom bot. [Withdrawn registration](https://github.com/okou-ai/okou/blob/b666cd0503/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L74).

- **Given** Official Lark is connected and a custom bot is unavailable.
- **When** Open Works with channel cards enabled.
- **Then** Lark shows Connected and Manage links to /settings/lark.
- **Upstream source** [Registration on main](https://github.com/okou-ai/okou/blob/579c32b870/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L41).
- **Disposition** Retained upstream ID in the execution ledger at `4855592c`. Rebuild pending after the kept-group withdrawal.
