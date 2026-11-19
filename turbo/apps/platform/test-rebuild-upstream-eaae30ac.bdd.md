# Upstream Platform test behavior through 4bf10b89

Use the upstream scenario title and registration link to verify the scoped action and any specific outcome before rebuilding. Frozen rows preserve the original ID where the registration was matched. The scenario ledger records remaining owner or entry-point questions. New rows stay outside the frozen reduction.

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

## chat-composer-connector-loading-001

Read connected inventory without fetching the connector directory or old authorization endpoints. [Registration](https://github.com/okou-ai/okou/blob/4bf10b89e09adce4c9253418d2ad8de1937e3e9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L46).

- **Given** The actor starts in the product surface described by the scenario.
- **When** The actor opens the permission surface and reviews or confirms the requested access.
- **Then** Read connected inventory without fetching the connector directory or old authorization endpoints.
- **Disposition** not_selected.

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
