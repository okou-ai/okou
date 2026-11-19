# Custom permission save lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-permission-save-lifecycle.test.tsx](custom-permission-save-lifecycle.test.tsx).

## custom-permission-save-lifecycle-001

Original test `Closing a pending permission save preserves another agent's permission draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-permission-save-lifecycle.test.tsx#L21).

- **Given** Research and Support both have the same custom-connector permission granted, and an update saving Research's changed permission is still pending.
- **When** I change Research's permission to Deny and close that dialog, then edit Support's permission while the earlier server response completes. I save Support's change and reopen its permission dialog.
- **Then** Closing Research's dialog aborts its pending request. Support's unsaved Deny choice remains selected despite the earlier response; after saving, the permission is persisted and reopening shows Deny selected with Apply disabled.
