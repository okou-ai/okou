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
