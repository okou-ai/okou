# Activity detail retained data

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-detail-retained-data.test.tsx](activity-detail-retained-data.test.tsx).

## activity-detail-retained-data-001

Original test `An unavailable activity shows a clear not-found page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-detail-retained-data.test.tsx#L109).

- **Given** A user opens an activity whose lookup returns 404 with a not-found error.
- **When** They view the activity page.
- **Then** A clear page headed “Log not found” is shown.

## activity-detail-retained-data-002

Original test `A user can download all retained diagnostics for an older activity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-detail-retained-data.test.tsx#L123).

- **Given** An older activity has retained event, context, and network diagnostics available.
- **When** The user downloads raw data from its activity page.
- **Then** One JSON file named with the activity ID and “-logs.json” is downloaded. It contains the event, activity metadata, captured context including variables, secrets and storage mounts, and network logs.

## activity-detail-retained-data-003

Original test `Activity context lists model route fields without runtime metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-detail-retained-data.test.tsx#L189).

- **Given** A user opens an activity’s Context tab with debug access enabled. Its route has selected model “gpt-5.6-luna” and provider “codex-oauth-token,” with runtime provider and model absent; it also has read-only and read/write storage mounts.
- **When** They inspect the Model Route and Storage Mounts sections.
- **Then** The selected model and provider are listed, while runtime provider and model appear as null. Both storage mounts show their names, versions, paths, and read-only or read/write access.
