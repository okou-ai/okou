# Upstream artifact preview toolbar order

[Registration for #48919](https://github.com/okou-ai/okou/blob/8a2029a4899dd8032955e0e0b102272bd94ad26f/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L202).

These four executions are upstream additions. The existing Preview
helper still enables grouping by default for the 15 frozen rows.

## upstream-48919-artifact-toolbar-dialog-ungrouped

- **Given** An artifact preview is available in the dialog with action grouping disabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** Download precedes the vertical separator, Enter fullscreen follows the separator, and Close follows Enter fullscreen.

## upstream-48919-artifact-toolbar-dialog-grouped

- **Given** An artifact preview is available in the dialog with action grouping enabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** More artifact actions precedes the vertical separator, Enter fullscreen follows the separator, and Close follows Enter fullscreen.

## upstream-48919-artifact-toolbar-sidebar-ungrouped

- **Given** An artifact preview is available in the sidebar with action grouping disabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** Download precedes the vertical separator, Enter fullscreen follows the separator, and Close artifact follows Enter fullscreen.

## upstream-48919-artifact-toolbar-sidebar-grouped

- **Given** An artifact preview is available in the sidebar with action grouping enabled.
- **When** The user opens the preview and the artifact actions are ready.
- **Then** More artifact actions precedes the vertical separator, Enter fullscreen follows the separator, and Close artifact follows Enter fullscreen.
