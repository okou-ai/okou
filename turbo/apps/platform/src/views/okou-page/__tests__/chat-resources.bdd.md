# Chat resources

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-resources.test.tsx](chat-resources.test.tsx).

## chat-resources-001

Original test `Open an empty chat's panel on press while it loads, then replace the loading state with its hint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L33).

- **Given** An empty chat is loaded while its artifact catalog request remains pending; its resource panel is initially closed.
- **When** The user opens the panel before the request completes.
- **Then** The panel opens immediately with a loading status and no empty-state message. When the request completes, it shows the empty-state hint and removes the loading status.

## chat-resources-002

Original test `Open a pressed panel at once, draw its resources complete, and reuse them when reopened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L80).

- **Given** A chat has pending resource requests, including an artifact and a related child chat that will be returned when loading completes.
- **When** The user opens the panel while those requests are pending, waits for them to complete, closes the panel, and reopens it after the service would return no resources.
- **Then** The panel opens immediately with a loading status, then shows the artifact and child chat with no loading status. Reopening retains both resources despite the changed service response.

## chat-resources-003

Original test `Display a resource loading error without showing an empty state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L166).

- **Given** The chat's artifact catalog request fails with a server error.
- **When** The user opens the resource panel.
- **Then** The panel displays “Could not load artifacts” rather than an empty-state message.

## chat-resources-004

Original test `Name the closed resource trigger in a tooltip until the panel opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L192).

- **Given** The resource panel is closed.
- **When** The user hovers over its trigger and then opens the panel.
- **Then** The trigger's tooltip says “Artifacts and chats” while closed and disappears when the panel opens.

## chat-resources-005

Original test `Show all three artifacts without an overflow control at the limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L205).

- **Given** The chat has exactly three artifacts.
- **When** The user opens the resource panel and views the artifacts section.
- **Then** All three artifacts are listed, and there is no overflow control.

## chat-resources-006

Original test `Expand and collapse the artifacts list in place`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L216).

- **Given** The open resource panel lists four artifacts, initially showing three.
- **When** The user expands the list and then collapses it.
- **Then** Expansion shows all four artifacts without closing the panel or opening a sidebar gallery. Collapse restores the three-item list and hides the fourth artifact.

## chat-resources-007

Original test `Show artifacts in the floating panel while links remain in the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L247).

- **Given** The chat has a report artifact and links in its transcript, and the floating resource panel is open.
- **When** The user views the panel and closes it using its header control.
- **Then** The panel shows the report and an Artifacts heading, while transcript links remain outside the panel. The trigger identifies the panel as a dialog and reflects that it is open; closing the panel returns the trigger and panel to the closed state.

## chat-resources-008

Original test `Show empty resources for a link-only chat with a link in message 0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L277).

- **Given** A link-only chat has 21 conversation exchanges, with a link in the assistant response at message index 0 and no artifacts. The latest exchange is visible while the first is not.
- **When** The user opens the resource panel.
- **Then** The panel shows “No artifacts yet” and contains no links.

## chat-resources-009

Original test `Show empty resources for a link-only chat with a link in message 20`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.test.tsx#L277).

- **Given** A link-only chat has 21 conversation exchanges, with a link in the assistant response at message index 20 and no artifacts. The latest exchange is visible while the first is not.
- **When** The user opens the resource panel.
- **Then** The panel shows “No artifacts yet” and contains no links.
