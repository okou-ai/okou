# Chat artifact action group

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-artifact-action-group.test.tsx](chat-artifact-action-group.test.tsx).

## chat-artifact-action-group-001

Original test `replacing the sidebar from another chat waits for that chat's metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L202).

- **Given** A sidebar previews an artifact from one chat, and a different chat's artifact metadata is still loading.
- **When** The user selects the second chat's artifact.
- **Then** The second artifact's content can appear, but Download remains hidden until its metadata arrives. After the metadata resolves, Download and More actions become available and the second artifact's title is shown.

## chat-artifact-action-group-002

Original test `the dialog reveals all actions together when ownership resolves first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L331).

- **Given** An artifact is open in the dialog, and ownership data is available before sharing data.
- **When** The user waits for both reads to finish.
- **Then** Until sharing resolves, the content is visible but Download is hidden; once it resolves, Download, Share, and More actions appear.

## chat-artifact-action-group-003

Original test `the dialog reveals all actions together when sharing resolves first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L331).

- **Given** An artifact is open in the dialog, and sharing data is available before ownership data.
- **When** The user waits for both reads to finish.
- **Then** Until ownership resolves, the content is visible but Download is hidden; once it resolves, Download, Share, and More actions appear.

## chat-artifact-action-group-004

Original test `the sidebar reveals all actions together when ownership resolves first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L331).

- **Given** An artifact is open in the sidebar, and ownership data is available before sharing data.
- **When** The user waits for both reads to finish.
- **Then** Until sharing resolves, the content is visible but Download is hidden; once it resolves, Download, Share, and More actions appear.

## chat-artifact-action-group-005

Original test `the sidebar reveals all actions together when sharing resolves first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L331).

- **Given** An artifact is open in the sidebar, and sharing data is available before ownership data.
- **When** The user waits for both reads to finish.
- **Then** Until ownership resolves, the content is visible but Download is hidden; once it resolves, Download, Share, and More actions appear.

## chat-artifact-action-group-006

Original test `the dialog waits for artifact metadata before choosing its actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L364).

- **Given** An artifact is open in the dialog while its chat artifact metadata is loading.
- **When** The user waits for the metadata to arrive.
- **Then** The content is visible and Download is hidden until metadata resolves; then Download and More actions appear.

## chat-artifact-action-group-007

Original test `the sidebar waits for artifact metadata before choosing its actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L364).

- **Given** An artifact is open in the sidebar while its chat artifact metadata is loading.
- **When** The user waits for the metadata to arrive.
- **Then** The content is visible and Download is hidden until metadata resolves; then Download and More actions appear.

## chat-artifact-action-group-008

Original test `the dialog can close during action loading and reopen normally`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L383).

- **Given** An artifact is open in the dialog while ownership data is loading.
- **When** The user closes the preview, waits for ownership to resolve, and reopens the artifact.
- **Then** The preview closes during loading and the reopened artifact eventually offers Download.

## chat-artifact-action-group-009

Original test `the sidebar can close during action loading and reopen normally`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L383).

- **Given** An artifact is open in the sidebar while ownership data is loading.
- **When** The user closes the preview, waits for ownership to resolve, and reopens the artifact.
- **Then** The preview closes during loading and the reopened artifact eventually offers Download.

## chat-artifact-action-group-010

Original test `the dialog keeps Download separate from deletion and restores More focus on cancel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L411).

- **Given** An owned artifact is open in the dialog with its actions loaded.
- **When** The user opens More actions, opens and closes Share, downloads the artifact from Download options, then cancels a deletion prompt.
- **Then** More actions contains only Delete, and the download uses the artifact's title as its filename. Cancelling deletion restores focus to More actions; confirming a later deletion shows an artifact-deleted message and closes the preview.

## chat-artifact-action-group-011

Original test `the sidebar keeps Download separate from deletion and restores More focus on cancel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L411).

- **Given** An owned artifact is open in the sidebar with its actions loaded.
- **When** The user opens More actions, opens and closes Share, downloads the artifact from Download options, then cancels a deletion prompt.
- **Then** More actions contains only Delete, and the download uses the artifact's title as its filename. Cancelling deletion restores focus to More actions; confirming a later deletion shows an artifact-deleted message and closes the preview.

## chat-artifact-action-group-012

Original test `a read-only dialog offers link copy and Download without an empty management menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L474).

- **Given** A read-only artifact is open in the dialog.
- **When** The user selects Share.
- **Then** The artifact link is copied, Download becomes available, and no More actions button is shown.

## chat-artifact-action-group-013

Original test `a read-only sidebar offers link copy and Download without an empty management menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L474).

- **Given** A read-only artifact is open in the sidebar.
- **When** The user selects Share.
- **Then** The artifact link is copied, Download becomes available, and no More actions button is shown.

## chat-artifact-action-group-014

Original test `a failed ownership read still releases Download and Close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L497).

- **Given** An artifact is open in the dialog and the ownership read fails.
- **When** The user opens Download options and selects Download.
- **Then** The download completes and Close remains enabled.

## chat-artifact-action-group-015

Original test `a failed sharing read still releases Download and Close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx#L497).

- **Given** An artifact is open in the dialog and the sharing read fails.
- **When** The user opens Download options and selects Download.
- **Then** The download completes and Close remains enabled.
