# Custom connector delete lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-connector-delete-lifecycle.test.tsx](custom-connector-delete-lifecycle.test.tsx).

## custom-connector-delete-lifecycle-001

Original test `A completed deletion preserves a newer connector draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-delete-lifecycle.test.tsx#L18).

- **Given** An organization admin is viewing a directory containing the custom connector “First API.”
- **When** They start deleting it, close the pending deletion, open a new connector form, and enter “Second API draft.” The deletion then completes.
- **Then** The directory shows its empty-state message, while the new connector form remains open with “Second API draft.”
