# Organization refresh

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [organization-refresh.test.tsx](organization-refresh.test.tsx).

## organization-refresh-001

Original test `A temporary authentication refresh keeps the active workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/organization-refresh.test.tsx#L34).

- **Given** The user is on the Agents page in Org A, with Org A as their active workspace.
- **When** Authentication temporarily reports no active workspace, then restores Org A.
- **Then** The Agents page and its URL remain unchanged throughout, and Org A remains available in the workspace switcher before and after restoration.

## organization-refresh-002

Original test `Reload the changed tab before using a new workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/organization-refresh.test.tsx#L95).

- **Given** The user is on the Agents page in Org A and also belongs to Org B.
- **When** The active workspace changes to Org B in the current tab.
- **Then** The app navigates to the root path before using the new workspace.
