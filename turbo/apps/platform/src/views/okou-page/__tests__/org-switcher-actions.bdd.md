# Org switcher actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-switcher-actions.test.tsx](org-switcher-actions.test.tsx).

## org-switcher-actions-001

Original test `Leaving the page during workspace creation reconciles the quota without activating its SDK result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher-actions.test.tsx#L67).

- **Given** A user can create at most one workspace and starts workspace creation from the switcher.
- **When** The user navigates to Connectors before workspace creation resolves, then creation succeeds.
- **Then** The creation quota is reconciled so Create workspace is no longer offered. The created workspace is not activated, and the user remains on Connectors.
- **Upstream change** `4e5707de` (#49556) retires the Agents page (`/agents` now redirects to Home with My Okou settings open), so the upstream test now starts on Home (`/`) and leaves through the Workflows sidebar link; the upstream test is now `Leaving the page during workspace creation reconciles the quota without activating its SDK result` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher-actions.test.tsx#L67)). Rebuild this scenario starting on `/` and navigating to Workflows instead of Connectors, expecting the user to remain on `/workflows`.

## org-switcher-actions-002

Original test `Failed workspace activation still reconciles the committed creation quota`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher-actions.test.tsx#L102).

- **Given** A user can create at most one workspace and workspace creation commits successfully.
- **When** Workspace activation fails.
- **Then** The creation quota is still reconciled so Create workspace is no longer offered, and the user remains on Agents.

## org-switcher-actions-003

Original test `Leaving the page during invitation acceptance removes the committed invitation without activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher-actions.test.tsx#L132).

- **Given** A user has a pending invitation to Invited Org and starts accepting it from the workspace switcher.
- **When** The user navigates to Connectors before acceptance resolves, then acceptance succeeds.
- **Then** The pending invitation and its badge are removed, but the invited workspace is not activated and the user remains on Connectors.
- **Upstream change** `4e5707de` (#49556) retires the Agents page (`/agents` now redirects to Home with My Okou settings open), so the upstream test now starts on Home (`/`) and leaves through the Workflows sidebar link; the upstream test is now `Leaving the page during invitation acceptance removes the committed invitation without activation` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher-actions.test.tsx#L132)). Rebuild this scenario starting on `/` and navigating to Workflows instead of Connectors, expecting the user to remain on `/workflows`.
