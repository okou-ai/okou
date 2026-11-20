# Chat navigation artifact sidebar

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-navigation-artifact-sidebar.test.tsx](chat-navigation-artifact-sidebar.test.tsx).

## chat-navigation-artifact-sidebar-001

Original test `Keep attachment cards closed until the user selects one`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L188).

- **Given** A chat contains attachment cards for a completed report and a report from a still-running task.
- **When** The user opens the chat.
- **Then** Both attachment cards are visible and neither the artifact preview pane nor the artifact list is open.

## chat-navigation-artifact-sidebar-002

Original test `Preview a DOCX attachment in the dialog and split view`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L266).

- **Given** A generated DOCX attachment is available in the chat.
- **When** The user opens its preview and then selects Open in split view.
- **Then** The attachment is shown in a visible, keyboard-focusable preview first in a dialog and then in the split view; both use the public Office viewer URL with the original attachment URL as its source.

## chat-navigation-artifact-sidebar-003

Original test `Preview a PPTX attachment in the dialog and split view`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L289).

- **Given** A generated PPTX attachment is available in the chat.
- **When** The user opens its preview and then selects Open in split view.
- **Then** The attachment is shown in a visible, keyboard-focusable preview first in a dialog and then in the split view; both use the public Office viewer URL with the original attachment URL as its source.

## chat-navigation-artifact-sidebar-004

Original test `Preview an XLSX attachment in the dialog and split view`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L312).

- **Given** A generated XLSX attachment is available in the chat.
- **When** The user opens its preview and then selects Open in split view.
- **Then** The attachment is shown in a visible preview first in a dialog and then in the split view; both use the public Office viewer URL with the original attachment URL as its source.

## chat-navigation-artifact-sidebar-005

Original test `Use a public URL for a private Office attachment preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L333).

- **Given** A private DOCX attachment has a signed private URL and a public URL available.
- **When** The user opens its preview.
- **Then** The Office viewer uses the public URL as its source, not the private signed URL.

## chat-navigation-artifact-sidebar-006

Original test `Render a generated private image and offer sharing by default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L367).

- **Given** A generated private PNG image is available through a private resource URL.
- **When** The user opens the image and then selects it to view its dialog.
- **Then** The embedded image and dialog image use the private resource URL, and the dialog offers sharing by default.

## chat-navigation-artifact-sidebar-007

Original test `public images use a protected thumbnail and open the original on https://a.okou.io/a1b2c3d4e5`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L406).

- **Given** A public image is hosted at https://a.okou.io/a1b2c3d4e5.png.
- **When** The user views the image and selects it to open the dialog.
- **Then** The embedded image uses a protected thumbnail URL with width 800, height 720, scale-down fitting, and quality 85; the dialog shows the original image URL.

## chat-navigation-artifact-sidebar-008

Original test `public images use a protected thumbnail and open the original on https://files.sites.vm7.io/aaaaaaaaaaaaaaaaaaaaaaaa`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L406).

- **Given** A public image is hosted at https://files.sites.vm7.io/aaaaaaaaaaaaaaaaaaaaaaaa.png.
- **When** The user views the image and selects it to open the dialog.
- **Then** The embedded image uses a protected thumbnail URL with width 800, height 720, scale-down fitting, and quality 85; the dialog shows the original image URL.

## chat-navigation-artifact-sidebar-009

Original test `Explain empty and unavailable CSV previews`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L425).

- **Given** The artifact list contains an empty CSV export and a CSV whose source returns HTTP 503.
- **When** The user opens each artifact preview in turn.
- **Then** The empty file is described as “Empty CSV.” and the unavailable file is described as “CSV preview unavailable.”

## chat-navigation-artifact-sidebar-010

Original test `Expand diagram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L489).

- **Given** A Markdown artifact contains a Mermaid deployment-flow diagram rendered in the preview pane.
- **When** The user enters fullscreen, opens the diagram source, expands the diagram, and closes the expanded view.
- **Then** The expanded diagram image has the same content as the inline diagram, uses a separate image URL, and its URL is revoked on close while the inline URL remains valid. Closing restores focus to the expand control, keeps fullscreen and the open source section intact, and Escape returns focus to the document without leaving fullscreen.

## chat-navigation-artifact-sidebar-011

Original test `Preview site`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L586).

- **Given** A hosted launch site is available as an artifact.
- **When** The user opens its preview, returns to the artifact list, toggles fullscreen there, reopens the preview, toggles fullscreen twice, and closes the preview from the actions menu.
- **Then** The site preview displays the hosted site URL and is accessible by its preview name in the pane and fullscreen. Closing the preview removes it and returns to the artifacts-and-chats control.

## chat-navigation-artifact-sidebar-012

Original test `Image zoom reset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L669).

- **Given** A launch graphic is open in the artifact preview pane at 100% zoom.
- **When** The user zooms in, enters and exits fullscreen, zooms in again, and resets zoom.
- **Then** Zooming in changes the level to 112%; entering fullscreen resets it to 100%, and it remains 100% on exit. Zooming in again reaches 112%, and Reset zoom returns it to 100%.

## chat-navigation-artifact-sidebar-013

Original test `Leave the mobile artifact pane through the chat list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L766).

- **Given** In standalone display mode on a mobile layout, the user has opened a hosted site artifact preview.
- **When** The user selects Back to chats.
- **Then** Navigation follows the Back to chats link, removes the site preview and artifact pane, and leaves main navigation visible.

## chat-navigation-artifact-sidebar-014

Original test `Show artifacts that belong to the current thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L810).

- **Given** The current chat thread has a release-notes artifact.
- **When** The user opens Artifacts and chats.
- **Then** The dialog displays the thread's release-notes artifact, and the artifact catalog is requested for the current thread.

## chat-navigation-artifact-sidebar-015

Original test `Return to the artifact list when a preview is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-sidebar.test.tsx#L852).

- **Given** The artifact list contains a report whose detail is unavailable because the artifact is no longer found.
- **When** The user opens the report preview and selects Back to artifacts.
- **Then** The unavailable message and return control are shown; selecting the control returns to the artifact list, where the report remains available to preview.
