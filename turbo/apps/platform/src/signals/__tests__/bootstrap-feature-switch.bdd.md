# Bootstrap feature switch

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [bootstrap-feature-switch.test.tsx](bootstrap-feature-switch.test.tsx).

## bootstrap-feature-switch-001

Original test `A signed-out page does not load workspace features`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.test.tsx#L14).

- **Given** A user is signed out and opens the sign-in page.
- **When** The page starts and the sign-in form becomes ready.
- **Then** It does not request workspace features.

## bootstrap-feature-switch-002

Original test `The app waits for authoritative workspace features before mounting`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.test.tsx#L36).

- **Given** A signed-in user opens the agents page while the authoritative workspace-feature response is still pending.
- **When** The app starts before that response is released, then receives the response enabling feature guides and disabling single-agent mode.
- **Then** Before the response, a bootstrap skeleton is visible, the app root is not mounted, and feature guides are not requested; afterward the Agents page mounts and feature guides are requested once.

## bootstrap-feature-switch-003

Original test `An upgrade required by the workspace switch request is shown during startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.test.tsx#L74).

- **Given** A user opens the agents page and the workspace feature-switch request returns the client-force-upgrade status.
- **When** The app starts.
- **Then** Startup rejects with that status, an "Update required" dialog is shown, and the Agents heading is not shown.

## bootstrap-feature-switch-004

Original test `A new member without overrides enters My Okou`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.test.tsx#L92).

- **Given** A new member has no workspace feature switches or overrides and opens the agents page.
- **When** The page initializes.
- **Then** The user is redirected to the root route, and the Agents heading is not shown.
