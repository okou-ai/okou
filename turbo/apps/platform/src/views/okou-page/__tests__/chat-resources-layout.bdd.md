# Chat resources layout

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-resources-layout.test.tsx](chat-resources-layout.test.tsx).

## chat-resources-layout-001

Original test `Dismiss the panel on a composer click, like other header panels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L25).

- **Given** The resources panel is open in a chat.
- **When** The user clicks the message composer.
- **Then** The panel closes and its trigger reports that it is collapsed.

## chat-resources-layout-002

Original test `Dismiss the panel with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L34).

- **Given** The resources panel is open and focused.
- **When** The user presses Escape.
- **Then** The panel closes and its trigger reports that it is collapsed.

## chat-resources-layout-003

Original test `Toggle resources on mobile and dismiss them from the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L45).

- **Given** The resources panel is closed on a mobile-sized layout.
- **When** The user toggles the resources open and then clicks the composer.
- **Then** The panel opens, then closes, and its trigger reports the collapsed state.

## chat-resources-layout-004

Original test `Toggle the artifact panel with the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L57).

- **Given** The resources panel is closed and its trigger has keyboard focus.
- **When** The user presses Space twice.
- **Then** The panel opens after the first press and closes after the second.

## chat-resources-layout-005

Original test `Return focus to the resource trigger when Escape dismisses its content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L72).

- **Given** The resources panel is open and focus is on the report.pdf artifact.
- **When** The user presses Escape.
- **Then** The panel closes, focus returns to the resources trigger, and the trigger reports collapsed state.

## chat-resources-layout-006

Original test `Preserve category expansion controls after switching to mobile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-layout.test.tsx#L95).

- **Given** The artifact list contains four reports, and its category has been expanded and collapsed on desktop.
- **When** The layout switches to mobile, then the user expands and collapses the artifact category.
- **Then** The fourth report, report-4.pdf, appears while expanded and is absent after collapsing.
