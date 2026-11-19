# Chat artifact deletion

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-artifact-deletion.test.tsx](chat-artifact-deletion.test.tsx).

## chat-artifact-deletion-001

Original test `a thread artifact can be deleted from the original lightbox toolbar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-deletion.test.tsx#L96).

- **Given** A thread artifact is open in the original lightbox toolbar, and deletion is available.
- **When** The user opens Delete, cancels, then opens Delete again and confirms.
- **Then** Cancelling leaves the artifact and preview intact and restores focus to Delete. Confirming shows an artifact-deleted message and closes the preview; reopening the artifact shows its content without a Delete button.

## chat-artifact-deletion-002

Original test `a thread artifact can be deleted from the original sidebar toolbar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-deletion.test.tsx#L96).

- **Given** A thread artifact is open in the original sidebar toolbar, and deletion is available.
- **When** The user opens Delete, cancels, then opens Delete again and confirms.
- **Then** Cancelling leaves the artifact and preview intact and restores focus to Delete. Confirming shows an artifact-deleted message and closes the preview; reopening the artifact shows its content without a Delete button.

## chat-artifact-deletion-003

Original test `a thread artifact can be deleted from the original resources toolbar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-deletion.test.tsx#L96).

- **Given** A thread artifact is open from the resources toolbar, and deletion is available.
- **When** The user opens Delete, cancels, then opens Delete again and confirms.
- **Then** Cancelling leaves the artifact and preview intact and restores focus to Delete. Confirming shows an artifact-deleted message and closes the preview; reopening the artifact shows its content without a Delete button.

## chat-artifact-deletion-004

Original test `a read-only artifact retains Download and link copy without owner deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-deletion.test.tsx#L174).

- **Given** A read-only thread artifact is open in the lightbox.
- **When** The user selects Share and opens Download options.
- **Then** The artifact link is copied, Download is enabled, and no Delete button is available.
