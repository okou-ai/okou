# Artifact deletion

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-deletion.test.tsx](artifact-deletion.test.tsx).

## artifact-deletion-001

Original test `preview cancellation and deletion keep the catalog consistent (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-deletion.test.tsx#L80).

- **Given** The catalog contains report.txt, and sidebar previews are disabled.
- **When** The user opens Delete, cancels, reopens the dialog with Enter, dismisses it with Escape, then confirms deletion while the request is pending and eventually completes.
- **Then** The dialog warns that downloaded copies already exist. Cancel and Escape return focus to Delete; while deletion is pending, Delete and Cancel are disabled, Close is unavailable, Escape does not dismiss the dialog, and the artifact remains in the catalog. On success, “Artifact deleted” and “No artifacts found” appear, the artifact is absent, and focus returns to the catalog.

## artifact-deletion-002

Original test `preview cancellation and deletion keep the catalog consistent (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-deletion.test.tsx#L80).

- **Given** The catalog contains report.txt, and sidebar previews are enabled.
- **When** The user opens Delete, cancels, reopens the dialog with Enter, dismisses it with Escape, then confirms deletion while the request is pending and eventually completes.
- **Then** The dialog warns that downloaded copies already exist. Cancel and Escape return focus to Delete; while deletion is pending, Delete and Cancel are disabled, Close is unavailable, Escape does not dismiss the dialog, and the artifact remains in the catalog. On success, “Artifact deleted” and “No artifacts found” appear, the artifact is absent, and focus returns to the catalog.

## artifact-deletion-003

Original test `a failed deletion can be cancelled, reopened, and retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-deletion.test.tsx#L165).

- **Given** The catalog contains report.txt, and the first deletion attempt will fail with a 503 error.
- **When** The user attempts deletion, cancels the failed dialog, closes and reopens the preview, then retries deletion successfully.
- **Then** The first attempt displays “Could not delete artifact,” does not show “Artifact deleted,” and leaves the artifact available with Delete enabled. Cancel closes the dialog and returns focus to Delete. The retry removes the artifact and shows “No artifacts found.”

## artifact-deletion-004

Original test `deleting a later-page artifact discards stale pages when the catalog refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-deletion.test.tsx#L219).

- **Given** The first catalog page contains keep-this.txt and has a later page containing report.txt.
- **When** The user loads the later page, deletes report.txt, and the catalog refreshes.
- **Then** The stale later-page artifact is discarded: report.txt is absent while keep-this.txt remains available.

## artifact-deletion-005

Original test `a new publication can reappear under the same catalog identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-deletion.test.tsx#L255).

- **Given** The hosted-site catalog contains a publication, which the user deletes; the server can subsequently publish it again under the same catalog identity.
- **When** The user switches to file artifacts and then back to website artifacts, triggering a fresh catalog request.
- **Then** The newly published artifact appears again in the hosted-site catalog.
