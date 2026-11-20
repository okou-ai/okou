# Custom connector edit lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-connector-edit-lifecycle.test.tsx](custom-connector-edit-lifecycle.test.tsx).

## custom-connector-edit-lifecycle-001

Original test `A custom connector displays its Cloudflare Access dependency without an activation control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-edit-lifecycle.test.tsx#L18).

- **Given** A custom connector named “Protected API” depends on the available Cloudflare Access gateway “Corporate gateway.”
- **When** The user opens the custom connectors page.
- **Then** The connector shows “Cloudflare Access: Corporate gateway” and has no activation control.

## custom-connector-edit-lifecycle-002

Original test `A completed edit preserves a newer connector draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-edit-lifecycle.test.tsx#L38).

- **Given** The user is editing “First API” and has changed its name to “Saved first API” and its prefix to “http://api.acme.test/v1/”.
- **When** The user saves the edit, closes the edit dialog while the save is pending, and opens a new custom connector draft named “Second API draft.” The save then completes.
- **Then** The saved connector appears as “Saved first API,” and the new connector dialog remains open with “Second API draft” preserved.
