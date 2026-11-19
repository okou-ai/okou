# Upstream Platform test behavior through 4bf10b89

Use the upstream scenario title and registration link to verify the scoped action and any specific outcome before rebuilding. Frozen rows preserve the original ID where the registration was matched. The scenario ledger records remaining owner or entry-point questions. New rows stay outside the frozen reduction.

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
