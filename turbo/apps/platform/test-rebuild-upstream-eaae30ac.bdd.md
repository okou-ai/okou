# Upstream Platform test behavior through 4bf10b89

Use the upstream scenario title and registration link to verify the scoped action and any specific outcome before rebuilding. Frozen rows preserve the original ID where the registration was matched. The scenario ledger records remaining owner or entry-point questions. New rows stay outside the frozen reduction.

## upstream-eaae30ac-markdown-docx-21-01

markdown DOCX export > creates a Word package with headings, emphasis, tables, and safe links. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L21).

- **Given** An exportable Markdown result contains headings, emphasis, a table and a link.
- **When** Export the result as DOCX.
- **Then** The Word package retains the heading, emphasis and table, and contains the safe hyperlink.
- **Disposition** retain.

## upstream-eaae30ac-markdown-docx-51-01

markdown DOCX export > fits wide CJK tables to a landscape page with content-sized columns. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L51).

- **Given** A Markdown result contains a wide table with CJK text.
- **When** Export the table to Word.
- **Then** The document uses a landscape section with columns sized to its content.
- **Disposition** retain.

## upstream-eaae30ac-markdown-docx-110-01

markdown DOCX export > preserves independent list start values and Word line breaks. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L110).

- **Given** The result has separate ordered lists and an explicit line break.
- **When** Export the Markdown to Word.
- **Then** Each list keeps its own starting number and the explicit line break is encoded in Word.
- **Disposition** not_selected.

## upstream-eaae30ac-markdown-docx-132-01

markdown DOCX export > exports native bookmarks, footnotes, equations, and task states. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L132).

- **Given** The result contains bookmarks, notes, math and task items.
- **When** Export the Markdown to Word.
- **Then** The resulting document contains native bookmarks, footnotes, equations and task state.
- **Disposition** retain.

## upstream-eaae30ac-markdown-docx-164-01

markdown DOCX export > honors cancellation before creating the document. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/lib/__tests__/markdown-docx.test.ts#L164).

- **Given** The export owner has already cancelled the operation.
- **When** Request DOCX export.
- **Then** The operation rejects cancellation before delivering Word bytes.
- **Disposition** not_selected.

## upstream-eaae30ac-agent-suggestions-988-01

Custom direction opens a form composer for the default Agent without touching its home draft. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L988).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Custom direction opens a form composer for the default Agent without touching its home draft. Relevant visible labels or feedback in the upstream scenario include “Keep my original draft”, “What decision should I make first?”.
- **Disposition** not_selected.

## upstream-eaae30ac-agent-suggestions-1019-01

Each inline direction keeps its own background and retains its text while browsing. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1019).

- **Given** The scenario starts with browsing.
- **When** The actor performs the scenario action through its product surface.
- **Then** Each inline direction keeps its own background and retains its text while browsing. Relevant visible labels or feedback in the upstream scenario include “Assess the risks first”.
- **Disposition** retain.

## upstream-eaae30ac-agent-suggestions-1074-01

A custom follow-up retains its form on failure and reuses its identities until acceptance. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1074).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** A custom follow-up retains its form on failure and reuses its identities until acceptance. Relevant visible labels or feedback in the upstream scenario include “Follow-up temporarily unavailable”, “All caught up”.
- **Disposition** retain.

## upstream-eaae30ac-agent-suggestions-1143-01

An accepted custom follow-up preserves a newer direction entered after returning to the page. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1143).

- **Given** The scenario starts with returning to the page.
- **When** The actor performs the scenario action through its product surface.
- **Then** An accepted custom follow-up preserves a newer direction entered after returning to the page.
- **Disposition** retain.

## upstream-eaae30ac-agent-suggestions-1181-01

The custom direction form sends the background files without the home draft. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1181).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** The custom direction form sends the background files without the home draft. Relevant visible labels or feedback in the upstream scenario include “My saved draft”.
- **Disposition** not_selected.

## agent-suggestions-032

For you mounts only the foreground content and retains a departure until its animation finishes. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1592).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** For you mounts only the foreground content and retains a departure until its animation finishes.
- **Disposition** not_selected.

## upstream-eaae30ac-agent-suggestions-1690-01

For you keeps custom directions in the inline composer and advances after sending. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1690).

- **Given** The scenario starts with sending.
- **When** The actor performs the scenario action through its product surface.
- **Then** For you keeps custom directions in the inline composer and advances after sending.
- **Disposition** retain.

## upstream-eaae30ac-agent-suggestions-2042-01

Don't nudge records the no-repeat direction and Undo targets that feedback. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2042).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Don't nudge records the no-repeat direction and Undo targets that feedback. Relevant visible labels or feedback in the upstream scenario include “Noted — please don’t nudge me about this again”.
- **Disposition** retain.

## upstream-eaae30ac-agent-suggestions-2072-01

Background and card artwork stay fixed through browsing, feedback and Undo. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2072).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Background and card artwork stay fixed through browsing, feedback and Undo. Relevant visible labels or feedback in the upstream scenario include “Suggestion dismissed”.
- **Disposition** not_selected.

## upstream-eaae30ac-agent-suggestions-2123-01

Horizontal swipes browse without consuming while vertical and input gestures stay local. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L2123).

- **Given** The scenario starts with vertical and input gestures stay local.
- **When** The actor performs the scenario action through its product surface.
- **Then** Horizontal swipes browse without consuming while vertical and input gestures stay local.
- **Disposition** not_selected.

## chat-batch-permissions-001

Review full scopes grouped by connector and apply the selected duration together. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L184).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Review full scopes grouped by connector and apply the selected duration together. Relevant visible labels or feedback in the upstream scenario include “Calendar Service”, “Reports Service”, “Other endpoints”, “Permission duration”.
- **Disposition** retain.

## chat-batch-permissions-002

Review every scope in a large batch as metadata and grants arrive separately. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L279).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Review every scope in a large batch as metadata and grants arrive separately. Relevant visible labels or feedback in the upstream scenario include “Loading permissions”, “Always”, “These permissions stay allowed until you change or revoke them.”, “Permissions allowed”.
- **Disposition** not_selected.

## chat-batch-permissions-003

Approve only missing scopes without reapplying or extending active grants. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L390).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Approve only missing scopes without reapplying or extending active grants. Relevant visible labels or feedback in the upstream scenario include “Permissions allowed”.
- **Disposition** retain.

## chat-batch-permissions-006

A batch save does not empty sibling permission cards during a grants reload. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L503).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A batch save does not empty sibling permission cards during a grants reload. Relevant visible labels or feedback in the upstream scenario include “Permissions allowed”, “Already allowed”.
- **Disposition** not_selected.

## upstream-eaae30ac-chat-capability-connectors-565-01

Read a canonical custom default only on action activation (connected). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L565).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Read a canonical custom default only on action activation (connected). Relevant visible labels or feedback in the upstream scenario include “Connect Workspace Search”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-capability-connectors-565-02

Read a canonical custom default only on action activation (reconnect-required). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L565).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Read a canonical custom default only on action activation (reconnect-required). Relevant visible labels or feedback in the upstream scenario include “Connect Workspace Search”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-capability-connectors-565-03

Read a canonical custom default only on action activation (configuration_incomplete). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L565).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Read a canonical custom default only on action activation (configuration_incomplete). Relevant visible labels or feedback in the upstream scenario include “Connect Workspace Search”.
- **Disposition** review-prior-upstream-or-remapped.

## chat-capability-connectors-007

Connect or reconnect a custom MCP default before resuming (false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L730).

- **Given** The scenario starts with resuming (false).
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect or reconnect a custom MCP default before resuming (false).
- **Disposition** not_selected.

## chat-capability-connectors-008

Connect or reconnect a custom MCP default before resuming (true). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L730).

- **Given** The scenario starts with resuming (true).
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect or reconnect a custom MCP default before resuming (true).
- **Disposition** retain.

## chat-capability-connectors-009

Keep an incomplete custom MCP reconnect open without resuming. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L746).

- **Given** A custom MCP OAuth account still needs reconnection and its attempt has not completed.
- **When** Open the chat connector card and start the reconnect flow.
- **Then** The reconnect UI remains open and the chat does not continue early.
- **Disposition** retain.

## chat-capability-connectors-011

Continue a chat with the saved default account of a connected connector. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L824).

- **Given** A connected builtin connector has a saved default account.
- **When** Activate the connector card in the conversation.
- **Then** The actual chat continues with the saved account.
- **Disposition** retain.

## chat-capability-connectors-012

A connector card observes a connection completed elsewhere. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L889).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A connector card observes a connection completed elsewhere.
- **Disposition** not_selected.

## chat-capability-connectors-015

Preserve an existing custom connector permission during reconnection. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.test.tsx#L977).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Preserve an existing custom connector permission during reconnection.
- **Disposition** not_selected.

## chat-capability-permissions-001

Expose the full permission scope on the card itself. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L134).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Expose the full permission scope on the card itself. Relevant visible labels or feedback in the upstream scenario include “Scope Service permissions”.
- **Disposition** not_selected.

## chat-capability-permissions-002

Fail closed on permission load and save errors. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L168).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Fail closed on permission load and save errors. Relevant visible labels or feedback in the upstream scenario include “Couldn”.
- **Disposition** retain.

## chat-capability-permissions-003

Hide confirmation when connector permission details are invalid. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L231).

- **Given** The scenario starts with connector permission details are invalid.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Hide confirmation when connector permission details are invalid. Relevant visible labels or feedback in the upstream scenario include “Couldn”, “Unknown permission”.
- **Disposition** not_selected.

## chat-capability-permissions-004

Reflect current connector permission decisions. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L286).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Reflect current connector permission decisions. Relevant visible labels or feedback in the upstream scenario include “Already denied”, “Expired”.
- **Disposition** retain.

## chat-capability-permissions-005

Permission cards keep the full operation pending and expose callback failure. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L368).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Permission cards keep the full operation pending and expose callback failure. Relevant visible labels or feedback in the upstream scenario include “Couldn”.
- **Disposition** retain.

## chat-capability-permissions-006

Review and confirm connector permissions individually. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L428).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Review and confirm connector permissions individually. Relevant visible labels or feedback in the upstream scenario include “Permission duration”.
- **Disposition** retain.

## chat-capability-phone-use-002

Show online phones and refresh on reopen. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L78).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Show online phones and refresh on reopen. Relevant visible labels or feedback in the upstream scenario include “Your phone”, “Owner iPhone”, “No phones online”.
- **Disposition** retain.

## chat-capability-phone-use-004

A selected phone stays visible offline so its chat access can be revoked. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L103).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** A selected phone stays visible offline so its chat access can be revoked. Relevant visible labels or feedback in the upstream scenario include “Offline”, “No phones online”.
- **Disposition** retain.

## chat-capability-phone-use-007

Authorize, switch and revoke a phone from this chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L171).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Authorize, switch and revoke a phone from this chat.
- **Disposition** retain.

## chat-capability-phone-use-009

A new chat saves its selected phone before the first message starts a Run. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L224).

- **Given** The scenario starts with the first message starts a Run.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** A new chat saves its selected phone before the first message starts a Run.
- **Disposition** retain.

## chat-capability-phone-use-010

A failed chat-authorization read recovers when reopening the menu. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L265).

- **Given** The scenario starts with reopening the menu.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A failed chat-authorization read recovers when reopening the menu.
- **Disposition** not_selected.

## chat-capability-phone-use-011

Rejected phone consent preserves the new-chat draft and never starts its Run. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L290).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Rejected phone consent preserves the new-chat draft and never starts its Run. Relevant visible labels or feedback in the upstream scenario include “Message”, “Phone access could not be saved”, “Use my phone”.
- **Disposition** retain.

## chat-cards-031

Connector account switches A → B → A keep their icon and continue with fresh callback IDs. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1091).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector account switches A → B → A keep their icon and continue with fresh callback IDs. Relevant visible labels or feedback in the upstream scenario include “Switch to Work GitHub?”, “Switched to Work GitHub”, “Switch to Personal GitHub?”, “Switched to Personal GitHub”.
- **Disposition** not_selected.

## chat-composer-account-selection-001

pagination results keep the selected account once. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L107).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Pagination results keep the selected account once.
- **Disposition** not_selected.

## chat-composer-account-selection-002

remote search results keep the selected account once. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L107).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Remote search results keep the selected account once.
- **Disposition** not_selected.

## chat-composer-connector-accounts-006

An unavailable account keeps the new-chat draft and attachments (edited while creating: false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L112).

- **Given** The scenario starts with creating: false).
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** An unavailable account keeps the new-chat draft and attachments (edited while creating: false).
- **Disposition** retain.

## chat-composer-connector-accounts-007

An unavailable account keeps the new-chat draft and attachments (edited while creating: true). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L112).

- **Given** The scenario starts with creating: true).
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** An unavailable account keeps the new-chat draft and attachments (edited while creating: true).
- **Disposition** retain.

## chat-composer-connector-accounts-008

Resending an unconfirmed creation reuses its chat and event identities. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L260).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Resending an unconfirmed creation reuses its chat and event identities. Relevant visible labels or feedback in the upstream scenario include “Use my personal GitHub account”.
- **Disposition** retain.

## upstream-eaae30ac-chat-composer-connector-focus-95-01

connector search, Chat accounts=%s > keeps filtered connectors accessible without losing search focus. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L95).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector search, Chat accounts=%s > keeps filtered connectors accessible without losing search focus. Relevant visible labels or feedback in the upstream scenario include “Find connectors...”, “Focus app 20”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-composer-connector-focus-104-01

connector search, Chat accounts=%s > focuses the loaded connector search during reopen. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L104).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector search, Chat accounts=%s > focuses the loaded connector search during reopen. Relevant visible labels or feedback in the upstream scenario include “Find connectors...”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-composer-connector-focus-119-01

connector search, Chat accounts=%s > does not take focus after keyboard navigation when search loads. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L119).

- **Given** The scenario starts with keyboard navigation when search loads.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector search, Chat accounts=%s > does not take focus after keyboard navigation when search loads.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-composer-connector-focus-133-01

connector search, Chat accounts=%s > preserves trigger focus when closed before loading. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L133).

- **Given** The scenario starts with closed before loading.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector search, Chat accounts=%s > preserves trigger focus when closed before loading.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-chat-composer-connector-focus-144-01

connector search, Chat accounts=%s > keeps mobile connector search unfocused after loading. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L144).

- **Given** The scenario starts with loading.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connector search, Chat accounts=%s > keeps mobile connector search unfocused after loading.
- **Disposition** review-prior-upstream-or-remapped.

## chat-composer-connector-focus-011

Searching connector names returns from account navigation to connector results. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-focus.test.tsx#L157).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Searching connector names returns from account navigation to connector results. Relevant visible labels or feedback in the upstream scenario include “Focus app 20 account access”.
- **Disposition** retain.

## chat-composer-connector-loading-001

Read connected inventory without fetching the connector directory or old authorization endpoints. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L46).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Read connected inventory without fetching the connector directory or old authorization endpoints.
- **Disposition** not_selected.

## chat-composer-connectors-001

Configure connector permissions from the composer. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L87).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Configure connector permissions from the composer. Relevant visible labels or feedback in the upstream scenario include “Axiom permissions”.
- **Disposition** retain.

## chat-composer-connectors-003

connecting a custom connector from Chat > cancel a custom connector from Chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L164).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connecting a custom connector from Chat > cancel a custom connector from Chat. Relevant visible labels or feedback in the upstream scenario include “Secret”.
- **Disposition** not_selected.

## chat-composer-connectors-004

connecting a custom connector from Chat > connect a custom connector from Chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L177).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connecting a custom connector from Chat > connect a custom connector from Chat. Relevant visible labels or feedback in the upstream scenario include “Acme Search”.
- **Disposition** not_selected.

## chat-composer-connectors-005

Reconnect the expired custom default from the composer with healthy siblings. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L199).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect the expired custom default from the composer with healthy siblings. Relevant visible labels or feedback in the upstream scenario include “Connect Acme Search”, “Secret”.
- **Disposition** not_selected.

## chat-composer-connectors-006

Show only the connector actions that are useful in chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L255).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Show only the connector actions that are useful in chat. Relevant visible labels or feedback in the upstream scenario include “Axiom”, “Work access”, “Personal access”, “GitHub”.
- **Disposition** retain.

## chat-composer-connectors-008

Start connector setup from chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L321).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Start connector setup from chat. Relevant visible labels or feedback in the upstream scenario include “Find connectors...”, “Google Analytics”.
- **Disposition** not_selected.

## chat-composer-connectors-009

Complete or cancel connector authorization from chat (null). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L380).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Complete or cancel connector authorization from chat (null). Relevant visible labels or feedback in the upstream scenario include “Find connectors...”, “Google Analytics”, “Close”.
- **Disposition** retain.

## chat-composer-connectors-010

Complete or cancel connector authorization from chat (Close). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L380).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Complete or cancel connector authorization from chat (Close). Relevant visible labels or feedback in the upstream scenario include “Find connectors...”, “Google Analytics”, “Close”.
- **Disposition** not_selected.

## chat-composer-connectors-011

Respect integration-managed connector availability in chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L440).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Respect integration-managed connector availability in chat. Relevant visible labels or feedback in the upstream scenario include “Feishu”, “Primary access”, “Secondary access”.
- **Disposition** retain.

## chat-composer-connectors-016

Enable a credential-free connector directly from chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.test.tsx#L565).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Enable a credential-free connector directly from chat.
- **Disposition** retain.

## chat-navigation-artifact-drive-006

Recheck Drive authorization after leaving and reopening the chat page. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L706).

- **Given** The scenario starts with leaving and reopening the chat page.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Recheck Drive authorization after leaving and reopening the chat page. Relevant visible labels or feedback in the upstream scenario include “Close”, “Artifacts”, “Artifact navigation”.
- **Disposition** not_selected.

## chat-navigation-artifact-drive-007

Connect Google Drive and sync an artifact. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L780).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect Google Drive and sync an artifact.
- **Disposition** not_selected.

## chat-navigation-artifact-drive-008

Recover missing Drive scope for a native upload only after explicit exact-account consent. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L835).

- **Given** The scenario starts with explicit exact-account consent.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Recover missing Drive scope for a native upload only after explicit exact-account consent. Relevant visible labels or feedback in the upstream scenario include “Download artifact”.
- **Disposition** retain.

## chat-navigation-artifact-drive-017

google editor conversion > reuses a reconnected Drive account for both upload modes in the same preview. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1278).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Google editor conversion > reuses a reconnected Drive account for both upload modes in the same preview.
- **Disposition** retain.

## upstream-eaae30ac-chat-run-artifact-carryover-135-01

Show format download items and report conversion failures in a toast. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L135).

- **Given** A Markdown output offers multiple download formats and conversion fails.
- **When** Open the download menu and choose an export format.
- **Then** The format actions are available and a failed conversion reports an error in a toast.
- **Disposition** retain.

## upstream-eaae30ac-chat-run-artifact-carryover-197-01

Download a Word export after selecting it in the Markdown artifact preview. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L197).

- **Given** A Markdown artifact is open in the preview.
- **When** Choose the Word download action.
- **Then** The browser offers the generated DOCX file.
- **Disposition** not_selected.

## upstream-eaae30ac-chat-run-history-769-01

Show working dots on scroll-to-bottom while the thread works. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L769).

- **Given** A thread is producing output while the reader is above the end.
- **When** Open the thread while the run is active and view the scroll-to-bottom control.
- **Then** The scroll-to-bottom control indicates ongoing activity.
- **Disposition** retain.

## upstream-eaae30ac-chat-thread-sidebar-resize-161-01

Each panel kind opens at its own width and keeps its own resize. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L161).

- **Given** A thread can open more than one type of side panel.
- **When** Open each panel and resize one of them.
- **Then** Each panel starts at its own width and remembers its own resize.
- **Disposition** retain.

## connectors-accounts-005

Show Mercury disclosures while managing its accounts. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-accounts.test.tsx#L344).

- **Given** The scenario starts with managing its accounts.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Show Mercury disclosures while managing its accounts. Relevant visible labels or feedback in the upstream scenario include “Manage Mercury accounts”.
- **Disposition** retain.

## connectors-auth-methods-001

Connect a builtin Automatic method resolving to none. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L163).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect a builtin Automatic method resolving to none. Relevant visible labels or feedback in the upstream scenario include “Partner Tools”, “Name your Partner Tools account”, “Connected”.
- **Disposition** not_selected.

## connectors-auth-methods-002

Connect a builtin Automatic method resolving to oauth. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L163).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect a builtin Automatic method resolving to oauth. Relevant visible labels or feedback in the upstream scenario include “Partner Tools”, “Name your Partner Tools account”, “Connected”.
- **Disposition** retain.

## connectors-auth-methods-004

Add an AWS account through external-code authorization. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L332).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Add an AWS account through external-code authorization. Relevant visible labels or feedback in the upstream scenario include “Name your AWS account”, “Connected”.
- **Disposition** retain.

## connectors-auth-methods-005

Add an account through OpenID. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L411).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Add an account through OpenID. Relevant visible labels or feedback in the upstream scenario include “Partner Steam”, “Name your Partner Steam account”, “Connected”.
- **Disposition** retain.

## connectors-auth-methods-008

Connect through device authorization. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L536).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Connect through device authorization. Relevant visible labels or feedback in the upstream scenario include “Base44”, “Name your Base44 account”, “Connected”.
- **Disposition** not_selected.

## upstream-eaae30ac-connectors-auth-methods-618-01

Reject device-auth completion when account setup is configuration_invalid. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L618).

- **Given** The scenario starts with account setup is configuration_invalid.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reject device-auth completion when account setup is configuration_invalid. Relevant visible labels or feedback in the upstream scenario include “This account needs additional setup. Review its connector settings and try again.”, “Close”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-connectors-auth-methods-618-02

Reject external-code completion when account setup is configuration_invalid. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L618).

- **Given** The scenario starts with account setup is configuration_invalid.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reject external-code completion when account setup is configuration_invalid. Relevant visible labels or feedback in the upstream scenario include “This account needs additional setup. Review its connector settings and try again.”, “Close”.
- **Disposition** review-prior-upstream-or-remapped.

## connectors-auth-methods-011

Enable a connector that needs no credentials. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L729).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Enable a connector that needs no credentials. Relevant visible labels or feedback in the upstream scenario include “Public Stripe enabled successfully”, “Name your Public Stripe account”, “Public Stripe”, “Connected”.
- **Disposition** not_selected.

## connectors-auth-methods-013

Complete OAuth only after the current attempt succeeds. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-auth-methods.test.tsx#L829).

- **Given** The scenario starts with the current attempt succeeds.
- **When** The actor performs the scenario action through its product surface.
- **Then** Complete OAuth only after the current attempt succeeds. Relevant visible labels or feedback in the upstream scenario include “Public Stripe”, “Connect Public Stripe”, “Connected”, “Research Agent”.
- **Disposition** retain.

## connectors-catalog-003

Show saved membership without loading accounts when catalog projections have been retired. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L63).

- **Given** The scenario starts with catalog projections have been retired.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Show saved membership without loading accounts when catalog projections have been retired. Relevant visible labels or feedback in the upstream scenario include “Connected”.
- **Disposition** not_selected.

## connectors-catalog-012

Land on Discover, then switch to the connectors this workspace has. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L380).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Land on Discover, then switch to the connectors this workspace has. Relevant visible labels or feedback in the upstream scenario include “Connected2”, “Gmail”, “Filter connectors”, “Filter: All”.
- **Disposition** retain.

## upstream-eaae30ac-connectors-custom-183-01

Do not complete or authorize an exact account when required configuration is incomplete. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L183).

- **Given** The scenario starts with required configuration is incomplete.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Do not complete or authorize an exact account when required configuration is incomplete. Relevant visible labels or feedback in the upstream scenario include “Connect Acme Search”, “Secret”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-connectors-custom-183-02

Do not complete or authorize an exact account when configuration is invalid. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L183).

- **Given** The scenario starts with configuration is invalid.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Do not complete or authorize an exact account when configuration is invalid. Relevant visible labels or feedback in the upstream scenario include “Connect Acme Search”, “Secret”.
- **Disposition** review-prior-upstream-or-remapped.

## connectors-custom-004

Add and optionally name a custom connector account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L324).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Add and optionally name a custom connector account. Relevant visible labels or feedback in the upstream scenario include “Secret”, “Connected”.
- **Disposition** not_selected.

## connectors-custom-010

Manage a custom HTTP connector through creation and connection. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L564).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Manage a custom HTTP connector through creation and connection. Relevant visible labels or feedback in the upstream scenario include “Add an HTTP API or MCP server for your organization to use.”, “New custom connector”, “Display name”, “Acme API”.
- **Disposition** retain.

## connectors-custom-013

Manage custom HTTP OAuth through configuration update and connection. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L836).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Manage custom HTTP OAuth through configuration update and connection. Relevant visible labels or feedback in the upstream scenario include “Edit custom connector”, “New client secret”, “Disconnect existing OAuth connections?”, “Acme API”.
- **Disposition** retain.

## connectors-custom-014

Manage a manual MCP connector through its lifecycle. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L979).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Manage a manual MCP connector through its lifecycle. Relevant visible labels or feedback in the upstream scenario include “New custom connector”, “Connector type”, “MCP · Streamable HTTP”, “Display name”.
- **Disposition** retain.

## connectors-custom-015

Create and connect an MCP server through automatic authorization. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1142).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Create and connect an MCP server through automatic authorization. Relevant visible labels or feedback in the upstream scenario include “New custom connector”, “Connector type”, “MCP · Streamable HTTP”, “Automatic”.
- **Disposition** retain.

## connectors-custom-017

Keep saved custom accounts manageable when only the default needs reconnect. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1271).

- **Given** The scenario starts with only the default needs reconnect.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Keep saved custom accounts manageable when only the default needs reconnect. Relevant visible labels or feedback in the upstream scenario include “Acme MCP”, “Connected”, “Empty MCP”, “No accounts”.
- **Disposition** retain.

## connectors-custom-018

Reconnect an OAuth account after cancelled consent and metadata changes. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1351).

- **Given** The scenario starts with cancelled consent and metadata changes.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect an OAuth account after cancelled consent and metadata changes. Relevant visible labels or feedback in the upstream scenario include “Manage Acme OAuth accounts”, “Connect Acme OAuth”, “Close”.
- **Disposition** retain.

## connectors-custom-020

Add and optionally name a custom OAuth account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1627).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Add and optionally name a custom OAuth account. Relevant visible labels or feedback in the upstream scenario include “Name your Acme Search account”, “Account name”, “Unnamed account”, “Acme Search”.
- **Disposition** retain.

## connectors-custom-022

Do not grant access after an unsuccessful custom connection. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1785).

- **Given** The scenario starts with an unsuccessful custom connection.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Do not grant access after an unsuccessful custom connection. Relevant visible labels or feedback in the upstream scenario include “Connect Acme Incomplete”, “Secret”, “Write unavailable”.
- **Disposition** retain.

## connectors-custom-025

Validate new and reconnecting custom accounts appropriately. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1926).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Validate new and reconnecting custom accounts appropriately. Relevant visible labels or feedback in the upstream scenario include “Manage Acme Search accounts”, “Connect Acme Search”, “Configured”, “Secret”.
- **Disposition** not_selected.

## custom-connector-connect-lifecycle-002

Keep a custom connection pending until its account naming continuation is ready. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-connect-lifecycle.test.tsx#L100).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Keep a custom connection pending until its account naming continuation is ready. Relevant visible labels or feedback in the upstream scenario include “Connect Acme Search”, “Secret”, “Name your Acme Search account”, “Account name”.
- **Disposition** not_selected.

## custom-default-reconnect-001

Reconnect an expired custom default with %i saved accounts. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L102).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect an expired custom default with %i saved accounts. Relevant visible labels or feedback in the upstream scenario include “Secret”.
- **Disposition** not_selected.

## custom-default-reconnect-002

Reconnect an expired custom default with %i saved accounts. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L102).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect an expired custom default with %i saved accounts. Relevant visible labels or feedback in the upstream scenario include “Secret”.
- **Disposition** not_selected.

## custom-default-reconnect-010

Reconnect the expired OAuth account after its completion receipt. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L449).

- **Given** The scenario starts with its completion receipt.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect the expired OAuth account after its completion receipt. Relevant visible labels or feedback in the upstream scenario include “Acme Search connected”.
- **Disposition** retain.

## custom-default-reconnect-011

Leave an incomplete OAuth reconnect unconfirmed. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L471).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Leave an incomplete OAuth reconnect unconfirmed.
- **Disposition** not_selected.

## directed-connect-page-001

Connect a manual MCP connector from a directed link. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L435).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect a manual MCP connector from a directed link. Relevant visible labels or feedback in the upstream scenario include “Okou needs DeepWiki to proceed”, “Connect DeepWiki”, “Secret”, “DeepWiki connected”.
- **Disposition** not_selected.

## directed-connect-page-002

Let an MCP server discover authentication from a directed connection. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L513).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Let an MCP server discover authentication from a directed connection. Relevant visible labels or feedback in the upstream scenario include “Okou needs Discovery MCP to proceed”, “Connect Discovery MCP”, “Continue while Okou checks how this MCP server authenticates.”, “Discovery MCP connected”.
- **Disposition** not_selected.

## directed-connect-page-004

Connect a custom OAuth connector from a directed link. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L672).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect a custom OAuth connector from a directed link. Relevant visible labels or feedback in the upstream scenario include “Okou needs Acme OAuth to proceed”, “Connect Acme OAuth”, “Acme OAuth connected”.
- **Disposition** retain.

## directed-connect-page-005

Reconnect the exact custom OAuth account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L767).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect the exact custom OAuth account. Relevant visible labels or feedback in the upstream scenario include “Acme OAuth Reconnect connected”, “Connect Acme OAuth Reconnect”.
- **Disposition** not_selected.

## directed-connect-page-007

Start public OAuth from a directed connection link. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L862).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Start public OAuth from a directed connection link. Relevant visible labels or feedback in the upstream scenario include “Okou needs Public GitHub to proceed”.
- **Disposition** not_selected.

## upstream-eaae30ac-directed-connect-page-924-01

Continue from an existing connector authorization link using the saved account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L924).

- **Given** A connector has an available saved account and the chat has a directed authorization link.
- **When** Open the link through the real router and choose the saved account.
- **Then** The current connect page continues the originating chat with the selected account.
- **Disposition** retain.

## directed-connect-page-008

Connect a no-auth connector and continue the originating chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1000).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Connect a no-auth connector and continue the originating chat. Relevant visible labels or feedback in the upstream scenario include “Okou needs Public Stripe to proceed”, “Public Stripe connected”.
- **Disposition** retain.

## directed-connect-page-012

Reconnect the expired public OAuth account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1215).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Reconnect the expired public OAuth account. Relevant visible labels or feedback in the upstream scenario include “Okou needs Public GitHub to proceed”, “Public GitHub”, “Connection expired”.
- **Disposition** retain.

## directed-connect-page-014

Connect a manual grant and continue the originating chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx#L1427).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Connect a manual grant and continue the originating chat. Relevant visible labels or feedback in the upstream scenario include “Okou needs Public Axiom to proceed”, “Public Axiom”, “Public Axiom connected”.
- **Disposition** retain.

## email-connect-page-003

adds an email from the Works card with a short code and updates the open dialog. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L98).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Adds an email from the Works card with a short code and updates the open dialog. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Email connections”, “Send the code from the email you want to add.”, “Open email”.
- **Disposition** retain.

## email-connect-page-005

keeps a failed code request in the dialog and lets the user retry. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L199).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Keeps a failed code request in the dialog and lets the user retry. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Email connections”, “Could not create a connection code. Try again.”, “Add email”.
- **Disposition** retain.

## email-connect-page-006

deletes each linked address from Manage and returns focus to Connect. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/email-connect-page.test.tsx#L235).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Deletes each linked address from Manage and returns focus to Connect. Relevant visible labels or feedback in the upstream scenario include “Email options”, “Manage”, “Email connections”, “Close”.
- **Disposition** not_selected.

## integrations-hub-status-001

Integrations show current status and refresh after GitHub connects. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L33).

- **Given** The scenario starts with gitHub connects.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Integrations show current status and refresh after GitHub connects. Relevant visible labels or feedback in the upstream scenario include “Slack”, “Connected (Okou HQ)”, “Update Permissions”, “Phone”.
- **Disposition** retain.

## integrations-hub-status-002

Slack keeps account disconnect in its overflow menu (admin: true). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L111).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Slack keeps account disconnect in its overflow menu (admin: true). Relevant visible labels or feedback in the upstream scenario include “Connected (Okou HQ)”, “More options”, “Disconnect”, “Connect”.
- **Disposition** retain.

## integrations-hub-status-003

Slack keeps account disconnect in its overflow menu (admin: false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L111).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Slack keeps account disconnect in its overflow menu (admin: false). Relevant visible labels or feedback in the upstream scenario include “Connected (Okou HQ)”, “More options”, “Disconnect”, “Connect”.
- **Disposition** not_selected.

## integrations-hub-status-004

A workspace member is directed to an admin for GitHub installation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L147).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A workspace member is directed to an admin for GitHub installation. Relevant visible labels or feedback in the upstream scenario include “Ask an organization admin to install the GitHub App”.
- **Disposition** not_selected.

## integrations-hub-status-005

Authorize the official Telegram bot directly in a new tab from Integrations. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L173).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Authorize the official Telegram bot directly in a new tab from Integrations. Relevant visible labels or feedback in the upstream scenario include “Telegram”, “Connect”.
- **Disposition** retain.

## integrations-hub-status-006

The phone card describes messaging and the connect dialog displays the destination number. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L276).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** The phone card describes messaging and the connect dialog displays the destination number. Relevant visible labels or feedback in the upstream scenario include “Text Okou a rough idea from your iPhone and ask for a first draft.”, “Connect phone”, “Text Okou from your iPhone”, “Copy +1 (314) 438-6568”.
- **Disposition** retain.

## integrations-hub-status-007

A user connects AgentPhone with a prefilled one-time code. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L314).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A user connects AgentPhone with a prefilled one-time code. Relevant visible labels or feedback in the upstream scenario include “Text Okou a rough idea from your iPhone and ask for a first draft.”, “Connect phone”, “Text Okou from your iPhone”, “Use iMessage when possible. SMS and MMS replies may not arrive reliably.”.
- **Disposition** retain.

## integrations-hub-status-008

An admin can begin Microsoft Teams installation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L400).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** An admin can begin Microsoft Teams installation. Relevant visible labels or feedback in the upstream scenario include “Paste your meeting notes into Teams and ask Okou to pull out the action items.”.
- **Disposition** not_selected.

## integrations-hub-status-009

Microsoft Teams offers Connect after installation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L428).

- **Given** The scenario starts with installation.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Microsoft Teams offers Connect after installation. Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** not_selected.

## integrations-hub-status-010

Microsoft Teams shows its connected account name. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L440).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Microsoft Teams shows its connected account name. Relevant visible labels or feedback in the upstream scenario include “Microsoft Teams”, “Connected (Avery)”, “Connect”.
- **Disposition** not_selected.

## integrations-hub-status-011

Uninstalling connected Microsoft Teams requires confirmation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L467).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Uninstalling connected Microsoft Teams requires confirmation. Relevant visible labels or feedback in the upstream scenario include “Microsoft Teams”, “More Microsoft Teams options”, “Uninstall Microsoft Teams”, “Uninstall Microsoft Teams integration?”.
- **Disposition** retain.

## integrations-hub-status-012

Slack starts OAuth directly and refreshes the original Works page (installed: false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L486).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Slack starts OAuth directly and refreshes the original Works page (installed: false). Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected (Verified workspace)”.
- **Disposition** retain.

## integrations-hub-status-013

Slack starts OAuth directly and refreshes the original Works page (installed: true). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L486).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Slack starts OAuth directly and refreshes the original Works page (installed: true). Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected (Verified workspace)”.
- **Disposition** not_selected.

## integrations-hub-status-014

Slack permission refresh reports actual scope recovery on the original Works page. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L521).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Slack permission refresh reports actual scope recovery on the original Works page. Relevant visible labels or feedback in the upstream scenario include “Update Permissions”, “Permissions updated”.
- **Disposition** not_selected.

## integrations-teams-001

Works reconciles Teams through focus without leaving its prompt. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L35).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Works reconciles Teams through focus without leaving its prompt. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected (Verified team)”.
- **Disposition** not_selected.

## integrations-teams-002

Works reconciles Teams through visibility without leaving its prompt. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L35).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Works reconciles Teams through visibility without leaving its prompt. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected (Verified team)”.
- **Disposition** not_selected.

## integrations-teams-003

Works reconciles Teams through realtime without leaving its prompt. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L35).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Works reconciles Teams through realtime without leaving its prompt. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected (Verified team)”.
- **Disposition** not_selected.

## integrations-teams-004

Works Connect starts the required Teams installation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L95).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Works Connect starts the required Teams installation. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Connected”.
- **Disposition** retain.

## integrations-teams-005

Returning to Works retries a failed Teams read without hiding the other integrations. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L114).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Returning to Works retries a failed Teams read without hiding the other integrations. Relevant visible labels or feedback in the upstream scenario include “Microsoft Teams”, “Unable to check your Teams connection.”, “Connect”.
- **Disposition** retain.

## integrations-teams-006

Teams actions preserve prompt and protected preview access. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L145).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Teams actions preserve prompt and protected preview access. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Microsoft Teams”.
- **Disposition** retain.

## integrations-teams-007

An overlapping focus refresh keeps later realtime notifications active. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L172).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** An overlapping focus refresh keeps later realtime notifications active. Relevant visible labels or feedback in the upstream scenario include “Connect”, “Microsoft Teams”, “Connected (Later installation)”.
- **Disposition** not_selected.

## integrations-teams-008

Members can connect a Teams identity without an organization bot. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L223).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Members can connect a Teams identity without an organization bot. Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** retain.

## integrations-teams-009

An independent Teams identity remains connected after bot removal. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L247).

- **Given** The scenario starts with bot removal.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** An independent Teams identity remains connected after bot removal. Relevant visible labels or feedback in the upstream scenario include “Connected (Personal identity tenant)”, “More Microsoft Teams options”, “Install in Teams”.
- **Disposition** retain.

## integrations-wechat-001

WeChat is hidden with its feature disabled. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L32).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** WeChat is hidden with its feature disabled.
- **Disposition** not_selected.

## integrations-wechat-007

the connected card identifies its workspace and WeChat account. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L241).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** The connected card identifies its workspace and WeChat account. Relevant visible labels or feedback in the upstream scenario include “Connected (Operations workspace · scanner-owner)”.
- **Disposition** not_selected.

## upstream-eaae30ac-integrations-wechat-258-01

a reconnect link identifies owner@example.com before confirmation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L258).

- **Given** The scenario starts with confirmation.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A reconnect link identifies owner@example.com before confirmation. Relevant visible labels or feedback in the upstream scenario include “Restore this WeChat connection to the account and workspace below.”, “WeChat Workspace”, “Workspace Assistant”, “Return to WeChat and send a message to start chatting.”.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-integrations-wechat-258-02

a reconnect link identifies user_wechat_confirm before confirmation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L258).

- **Given** The scenario starts with confirmation.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A reconnect link identifies user_wechat_confirm before confirmation. Relevant visible labels or feedback in the upstream scenario include “Restore this WeChat connection to the account and workspace below.”, “WeChat Workspace”, “Workspace Assistant”, “Return to WeChat and send a message to start chatting.”.
- **Disposition** review-prior-upstream-or-remapped.

## integrations-wechat-010

an unavailable reconnect link offers the same QR connection flow on the settings page. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L341).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** An unavailable reconnect link offers the same QR connection flow on the settings page. Relevant visible labels or feedback in the upstream scenario include “Connect with a new QR code”, “Verification code”, “Verify”, “Return to WeChat and send a message to start chatting.”.
- **Disposition** retain.

## integrations-wechat-011

a rejected reconnect remains unconnected and shows recovery guidance. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L395).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A rejected reconnect remains unconnected and shows recovery guidance. Relevant visible labels or feedback in the upstream scenario include “Restore this WeChat connection to the account and workspace below.”, “Reconnect”, “This link is unavailable”.
- **Disposition** retain.

## integrations-wechat-012

the WeChat settings page cannot connect with the feature disabled. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx#L436).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** The WeChat settings page cannot connect with the feature disabled. Relevant visible labels or feedback in the upstream scenario include “Connection is not configured yet.”.
- **Disposition** not_selected.

## markdown-permission-batch-001

A markdown batch link renders grouped permissions without duplicate rows. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L73).

- **Given** A chat asks for connector permissions grouped by connector.
- **When** Approve the batch and allow continuation to settle.
- **Then** Saved grants remain effective whether continuation succeeds or reports a failure.
- **Disposition** not_selected.

## markdown-permission-batch-002

A batch card shows three service logos and exposes every service in its overflow tooltip. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L178).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** A batch card shows three service logos and exposes every service in its overflow tooltip.
- **Disposition** retain.

## markdown-permission-batch-003

A partially allowed batch shows the remaining permission count. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L211).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A partially allowed batch shows the remaining permission count.
- **Disposition** retain.

## markdown-permission-batch-004

A batch stays reviewable while service details load and enables duration only when ready. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L236).

- **Given** The scenario starts with service details load and enables duration only when ready.
- **When** The actor performs the scenario action through its product surface.
- **Then** A batch stays reviewable while service details load and enables duration only when ready. Relevant visible labels or feedback in the upstream scenario include “Loading permissions”, “Allow the following permissions”, “Permission duration”, “Slack”.
- **Disposition** retain.

## markdown-permission-batch-005

A batch card reports saving and then allowed after the user confirms. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L295).

- **Given** The scenario starts with the user confirms.
- **When** The actor performs the scenario action through its product surface.
- **Then** A batch card reports saving and then allowed after the user confirms. Relevant visible labels or feedback in the upstream scenario include “Allow the following permissions”, “Saving...”, “Permission duration”, “Permissions allowed”.
- **Disposition** retain.

## markdown-table-export-015

Cloud exports preserve the selected account and upload mode (ready). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Cloud exports preserve the selected account and upload mode (ready). Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** retain.

## markdown-table-export-016

Cloud exports preserve the selected account and upload mode (authorize). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Cloud exports preserve the selected account and upload mode (authorize). Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** retain.

## markdown-table-export-017

Cloud exports preserve the selected account and upload mode (connect). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Cloud exports preserve the selected account and upload mode (connect). Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** retain.

## markdown-table-export-018

Cloud exports preserve the selected account and upload mode (reconnect). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-table-export.test.tsx#L469).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Cloud exports preserve the selected account and upload mode (reconnect). Relevant visible labels or feedback in the upstream scenario include “Connect”.
- **Disposition** not_selected.

## upstream-eaae30ac-platform-feed-events-419-01

A pause update explains the failure, shows the description, and links to the exact automation in a new tab. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L419).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** A pause update explains the failure, shows the description, and links to the exact automation in a new tab. Relevant visible labels or feedback in the upstream scenario include “Daily work summary”, “System update”.
- **Disposition** review-prior-upstream-or-remapped.

## preferences-page-001

A missing workspace theme follows the system and explicit choices are saved. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L98).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** A missing workspace theme follows the system and explicit choices are saved. Relevant visible labels or feedback in the upstream scenario include “Your preferred color scheme”.
- **Disposition** retain.

## preferences-page-002

A saved workspace mode overrides the cookie and saves independently of the palette. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L142).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** A saved workspace mode overrides the cookie and saves independently of the palette. Relevant visible labels or feedback in the upstream scenario include “Your preferred color scheme”, “Color theme”.
- **Disposition** retain.

## upstream-eaae30ac-preferences-page-221-01

Appearance choices made during startup survive the initial workspace read. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L221).

- **Given** The workspace's appearance read is still pending.
- **When** Change appearance and allow the initial read to finish.
- **Then** The completed startup does not overwrite the choices made while it was pending.
- **Disposition** retain.

## preferences-page-003

A failed theme save keeps the local choice and can be retried. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L278).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** A failed theme save keeps the local choice and can be retried. Relevant visible labels or feedback in the upstream scenario include “Your preferred color scheme”, “Theme preference could not be saved”.
- **Disposition** not_selected.

## preferences-page-004

A cached palette is visible during startup and cleared when the workspace uses the default. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L341).

- **Given** The scenario starts with the workspace uses the default.
- **When** The actor performs the scenario action through its product surface.
- **Then** A cached palette is visible during startup and cleared when the workspace uses the default. Relevant visible labels or feedback in the upstream scenario include “Color theme”.
- **Disposition** retain.

## preferences-page-009

First paint cleans up duplicate cookies before the shared workspace mode loads. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L655).

- **Given** The scenario starts with the shared workspace mode loads.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** First paint cleans up duplicate cookies before the shared workspace mode loads. Relevant visible labels or feedback in the upstream scenario include “Your preferred color scheme”.
- **Disposition** retain.

## settings-refresh-state-001

saving send mode updates the setting from the write response. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L86).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Saving send mode updates the setting from the write response. Relevant visible labels or feedback in the upstream scenario include “Cloud browser”.
- **Disposition** not_selected.

## upstream-eaae30ac-settings-refresh-state-109-01

overlapping saves preserve each confirmed preference. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L109).

- **Given** Two different preference writes can overlap.
- **When** Change two preferences while the first response is pending.
- **Then** The resulting controls show both confirmed choices.
- **Disposition** retain.

## upstream-eaae30ac-settings-refresh-state-140-01

overlapping saves to one preference read back the committed value. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L140).

- **Given** The same preference receives more than one write before the older one settles.
- **When** Change the setting again while the first save is still pending.
- **Then** The control reconciles to the committed value returned by the read.
- **Disposition** not_selected.

## settings-refresh-state-003

saving Learning (initially false) keeps enabled Suggestions unchanged while the save is pending. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L203).

- **Given** The scenario starts with the save is pending.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Saving Learning (initially false) keeps enabled Suggestions unchanged while the save is pending. Relevant visible labels or feedback in the upstream scenario include “Suggestions”.
- **Disposition** retain.

## settings-refresh-state-004

saving Learning (initially true) keeps enabled Suggestions unchanged while the save is pending. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L203).

- **Given** The scenario starts with the save is pending.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Saving Learning (initially true) keeps enabled Suggestions unchanged while the save is pending. Relevant visible labels or feedback in the upstream scenario include “Suggestions”.
- **Disposition** not_selected.

## settings-refresh-state-005

reopening Settings refreshes a Learning preference changed elsewhere after a save. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L268).

- **Given** The scenario starts with a save.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Reopening Settings refreshes a Learning preference changed elsewhere after a save. Relevant visible labels or feedback in the upstream scenario include “Learning”, “Close”, “Test User”, “Settings”.
- **Disposition** retain.

## settings-refresh-state-006

returning to Preference refreshes a Learning preference changed elsewhere after a save. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L268).

- **Given** The scenario starts with a save.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Returning to Preference refreshes a Learning preference changed elsewhere after a save. Relevant visible labels or feedback in the upstream scenario include “Learning”, “Close”, “Test User”, “Settings”.
- **Disposition** not_selected.

## settings-refresh-state-007

saving time zone keeps enabled Morning brief unchanged. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L336).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Saving time zone keeps enabled Morning brief unchanged. Relevant visible labels or feedback in the upstream scenario include “Morning brief”, “Eastern Time (ET)”.
- **Disposition** retain.

## upstream-eaae30ac-settings-refresh-state-369-01

updates Morning brief from the save response while leaving other preferences usable. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L369).

- **Given** The scenario starts with leaving other preferences usable.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Updates Morning brief from the save response while leaving other preferences usable.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-settings-refresh-state-369-02

updates Suggestions from the save response while leaving other preferences usable. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L369).

- **Given** The scenario starts with leaving other preferences usable.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Updates Suggestions from the save response while leaving other preferences usable.
- **Disposition** review-prior-upstream-or-remapped.

## upstream-eaae30ac-settings-refresh-state-369-03

updates Learning from the save response while leaving other preferences usable. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L369).

- **Given** The scenario starts with leaving other preferences usable.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** Updates Learning from the save response while leaving other preferences usable.
- **Disposition** review-prior-upstream-or-remapped.

## settings-refresh-state-011

a Morning brief refresh failure after returning to Preference reports the error and disables the switch. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/settings-refresh-state.test.tsx#L440).

- **Given** The scenario starts with returning to Preference reports the error and disables the switch.
- **When** The actor opens the preference surface and makes the indicated change or reopens its saved setting.
- **Then** A Morning brief refresh failure after returning to Preference reports the error and disables the switch. Relevant visible labels or feedback in the upstream scenario include “Cloud browser”, “Morning brief”.
- **Disposition** retain.

## unified-chat-workspace-001

The unified workspace opens each side panel at its default width and resizes it from the keyboard. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L91).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** The unified workspace opens each side panel at its default width and resizes it from the keyboard. Relevant visible labels or feedback in the upstream scenario include “Preview Unified report.txt”.
- **Disposition** retain.

## unified-chat-workspace-002

Double-clicking the side panel divider restores its default width. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/unified-chat-workspace.test.tsx#L123).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Double-clicking the side panel divider restores its default width.
- **Disposition** retain.

## upstream-eaae30ac-works-channel-status-15-01

Works distinguishes Feishu and Lark connection states on the same page. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L15).

- **Given** Feishu and Lark have different connectivity states.
- **When** Open Works.
- **Then** Each channel shows its own result and available action.
- **Disposition** retain.

## upstream-eaae30ac-works-channel-status-41-01

Works recognizes an official Lark connection without a custom bot. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L41).

- **Given** An official Lark connection is active with no custom bot.
- **When** Open Works.
- **Then** The Lark connection is recognized as connected.
- **Disposition** retain.

## upstream-eaae30ac-works-channel-status-68-01

Works keeps the original Teams installation action and copy with cards off. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/works-channel-status.test.tsx#L68).

- **Given** The new cards experience is disabled for this session.
- **When** Open Works and inspect the Teams connection entry.
- **Then** The original Teams installation action and instructions remain available.
- **Disposition** not_selected.

## permission-allow-page-002

A user grants a time-limited connector permission and resumes the chat. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L242).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A user grants a time-limited connector permission and resumes the chat. Relevant visible labels or feedback in the upstream scenario include “Hey Dana, you”, “Catalog Slack”, “Read catalog analytics”, “Permission duration”.
- **Disposition** not_selected.

## permission-allow-page-005

A user can allow a connector's uncatalogued endpoints without exposing an internal token. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L398).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A user can allow a connector's uncatalogued endpoints without exposing an internal token. Relevant visible labels or feedback in the upstream scenario include “Hey Casey, you”, “Cloudflare”, “Other endpoints”, “Permissions updated”.
- **Disposition** not_selected.

## permission-allow-page-008

An older permission link can still deny connector access safely. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-allow-page.test.tsx#L499).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** An older permission link can still deny connector access safely. Relevant visible labels or feedback in the upstream scenario include “Hey Morgan, you”, “Slack”, “Access workspace analytics data”, “Permissions denied”.
- **Disposition** retain.

## permission-batch-page-003

Grouped permissions remain allowed after continuation success (My Okou=false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L142).

- **Given** A chat asks for connector permissions grouped by connector.
- **When** Approve the batch and allow continuation to settle.
- **Then** The page shows that both permissions were allowed and the chat has continued.
- **Disposition** retain.

## permission-batch-page-002

Grouped permissions remain allowed after continuation failure (My Okou=false). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L142).

- **Given** A chat asks for connector permissions grouped by connector.
- **When** Approve the batch and allow continuation to settle.
- **Then** The page still shows that both permissions were allowed and separately reports that the chat could not continue.
- **Disposition** retain.

## permission-batch-page-005

Grouped permissions remain allowed after continuation success (My Okou=true). [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L142).

- **Given** A chat asks for connector permissions grouped by connector.
- **When** Approve the batch and allow continuation to settle.
- **Then** Saved grants remain effective whether continuation succeeds or reports a failure.
- **Disposition** not_selected.

## permission-batch-page-006

Navigating from a dismissed batch isolates the next agent's permissions and continuation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L236).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Navigating from a dismissed batch isolates the next agent's permissions and continuation. Relevant visible labels or feedback in the upstream scenario include “Permission duration”, “No permissions were changed.”, “The chat has continued.”, “Next Bot”.
- **Disposition** retain.

## permission-batch-page-007

Navigating from a continued batch isolates the next agent's permissions and continuation. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L236).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Navigating from a continued batch isolates the next agent's permissions and continuation. Relevant visible labels or feedback in the upstream scenario include “Permission duration”, “No permissions were changed.”, “The chat has continued.”, “Next Bot”.
- **Disposition** not_selected.

## permission-batch-page-011

A successful HTTP response without all grant acknowledgments cannot continue. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/permission-allow/__tests__/permission-batch-page.test.tsx#L381).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A successful HTTP response without all grant acknowledgments cannot continue. Relevant visible labels or feedback in the upstream scenario include “Description for chat:write”.
- **Disposition** retain.

## permission-editor-002

A denied permission does not keep the group's expiration. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L306).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A denied permission does not keep the group's expiration.
- **Disposition** retain.

## permission-editor-003

An individual permission duration overrides its group. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L342).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** An individual permission duration overrides its group. Relevant visible labels or feedback in the upstream scenario include “Always”.
- **Disposition** retain.

## permission-editor-004

Undoing a deny does not create an unnecessary always grant. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L380).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Undoing a deny does not create an unnecessary always grant. Relevant visible labels or feedback in the upstream scenario include “Always”.
- **Disposition** not_selected.

## permission-editor-005

Activating an already allowed bulk policy also allows other endpoints only on Apply. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L401).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor performs the scenario action through its product surface.
- **Then** Activating an already allowed bulk policy also allows other endpoints only on Apply.
- **Disposition** not_selected.

## permission-editor-006

Ask and mixed permissions remain distinct while group commands keep their scope. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L434).

- **Given** The scenario starts with group commands keep their scope.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Ask and mixed permissions remain distinct while group commands keep their scope. Relevant visible labels or feedback in the upstream scenario include “Mixed”, “Read allow options”.
- **Disposition** not_selected.

## team-navigation-001

Chat connector accounts keeps agent editing available without old authorization controls:. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L16).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Chat connector accounts keeps agent editing available without old authorization controls:. Relevant visible labels or feedback in the upstream scenario include “Research Agent”, “Name”, “Agent details section”, “Instructions”.
- **Disposition** retain.

## team-navigation-002

Chat connector accounts keeps agent editing available without old authorization controls: ?tab=authorization. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L16).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Chat connector accounts keeps agent editing available without old authorization controls: ?tab=authorization. Relevant visible labels or feedback in the upstream scenario include “Research Agent”, “Name”, “Agent details section”, “Instructions”.
- **Disposition** retain.

## team-navigation-003

Chat connector accounts preserves a member's chat access without exposing agent editing. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L43).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Chat connector accounts preserves a member's chat access without exposing agent editing. Relevant visible labels or feedback in the upstream scenario include “Research Agent”, “Chat with Research Agent”.
- **Disposition** not_selected.

## team-permissions-002

A user can restore the saved connector-policy baseline. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L302).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** A user can restore the saved connector-policy baseline.
- **Disposition** not_selected.

## team-permissions-003

Closing connector permissions discards unapplied changes. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L329).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Closing connector permissions discards unapplied changes.
- **Disposition** not_selected.

## team-permissions-005

Grouped and individual connector policies submit together. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L467).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the indicated connection surface and follows the available account action.
- **Then** Grouped and individual connector policies submit together.
- **Disposition** not_selected.

## team-permissions-006

A user can change one connector permission from temporary to permanent. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L500).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A user can change one connector permission from temporary to permanent.
- **Disposition** retain.

## team-permissions-007

A user can find and save a permission beyond the initially visible list. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L566).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** A user can find and save a permission beyond the initially visible list. Relevant visible labels or feedback in the upstream scenario include “Find permissions”.
- **Disposition** retain.
