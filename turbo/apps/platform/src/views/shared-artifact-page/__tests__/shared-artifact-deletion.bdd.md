# Shared artifact deletion

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-artifact-deletion.test.tsx](shared-artifact-deletion.test.tsx).

## shared-artifact-deletion-001

Original test `the owner can cancel and delete a file from its shared page (legacy=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L178).

- **Given** The owner is viewing a shared file page using the current reference format.
- **When** They open and cancel deletion, then confirm deletion.
- **Then** Cancel closes the dialog, restores focus to Delete, and keeps the page path unchanged. Confirmation disables Delete and Cancel while deleting, then shows “No artifacts found” and navigates to /artifacts.

## shared-artifact-deletion-002

Original test `the owner can cancel and delete a file from its shared page (legacy=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L178).

- **Given** The owner is viewing a shared file page using the legacy /share/artifacts path.
- **When** They open and cancel deletion, then confirm deletion.
- **Then** Cancel closes the dialog, restores focus to Delete, and keeps the legacy path unchanged. Confirmation disables Delete and Cancel while deleting, then shows “No artifacts found” and navigates to /artifacts.

## shared-artifact-deletion-003

Original test `the owner can cancel and delete a html from its shared page (legacy=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L178).

- **Given** The owner is viewing a shared HTML artifact page.
- **When** They open and cancel deletion, then confirm deletion.
- **Then** Cancel closes the dialog, restores focus to Delete, and keeps the page path unchanged. Confirmation disables Delete and Cancel while deleting, then shows “No artifacts found” and navigates to /artifacts.

## shared-artifact-deletion-004

Original test `the owner can cancel and delete a shared-thread from its shared page (legacy=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L178).

- **Given** The owner is viewing a shared-thread page.
- **When** They open and cancel deletion, then confirm deletion.
- **Then** Cancel closes the dialog, restores focus to Delete, and keeps the page path unchanged. The confirmation says the shared link will stop working; deletion disables Delete and Cancel while in progress, then shows “No artifacts found” and navigates to /artifacts.

## shared-artifact-deletion-005

Original test `a failed deletion keeps the shared page and allows retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L224).

- **Given** The owner is viewing a shared file page and the first deletion request fails with a service-unavailable response.
- **When** They confirm deletion, then retry after the failure.
- **Then** The error “Could not delete artifact” appears, the dialog remains open with Delete enabled, and the page path is unchanged. Retrying succeeds, shows “No artifacts found,” and navigates to /artifacts.

## shared-artifact-deletion-006

Original test `cancelling file deletion after a token refresh restores the owner action's focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L256).

- **Given** The owner has opened the deletion dialog for a shared file page.
- **When** A token refresh occurs and they cancel deletion before the refresh completes.
- **Then** The dialog closes, and after the refresh completes focus returns to Delete.

## shared-artifact-deletion-007

Original test `cancelling shared-thread deletion after a token refresh restores the owner action's focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L256).

- **Given** The owner has opened the deletion dialog for a shared-thread page.
- **When** A token refresh occurs and they cancel deletion before the refresh completes.
- **Then** The dialog closes, and after the refresh completes focus returns to Delete.

## shared-artifact-deletion-008

Original test `a read-only recipient cannot delete a file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L285).

- **Given** A read-only recipient is viewing a shared file page.
- **When** They view the available page actions.
- **Then** Share is available, but Delete is not offered.

## shared-artifact-deletion-009

Original test `a read-only recipient cannot delete a shared-thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L285).

- **Given** A read-only recipient is viewing a shared-thread page.
- **When** They view the available page actions.
- **Then** Share is available, but Delete is not offered.

## shared-artifact-deletion-010

Original test `the signed-out artifact viewer does not offer deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L303).

- **Given** A signed-out visitor is viewing an artifact.
- **When** The artifact viewer loads.
- **Then** The attachment preview is shown, but Delete is not offered.

## shared-artifact-deletion-011

Original test `the snapshot artifact viewer does not offer deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-deletion.test.tsx#L303).

- **Given** A visitor is viewing a snapshot artifact.
- **When** The artifact viewer loads.
- **Then** The attachment preview is shown, but Delete is not offered.
