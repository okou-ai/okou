# Settings model loading

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-model-loading.test.tsx](settings-model-loading.test.tsx).

## settings-model-loading-001

Original test `Keep loaded model controls usable when switching Settings sections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.test.tsx#L131).

- **Given** Model settings have loaded and the Connect account control is enabled, while subsequent billing and subscription responses are pending.
- **When** The user switches to Preference and then returns to Models.
- **Then** The Models heading and the no-accounts-connected message appear, and Connect account remains enabled.

## settings-model-loading-002

Original test `Keep loaded model controls usable after reopening Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.test.tsx#L141).

- **Given** Model settings have loaded and the Connect account control is enabled, while subsequent billing and subscription responses are pending.
- **When** The user closes Settings, reopens it from the account menu, and opens Models again.
- **Then** Connect account remains enabled.

## settings-model-loading-003

Original test `Apply realtime billing changes after reopening Settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.test.tsx#L149).

- **Given** The user reopens Models settings with a balance of 20,000 credits, then opens Credit balance while billing responses are pending.
- **When** The pending responses are released, the balance changes to 25,000 credits, and a billing-change event arrives.
- **Then** Credit balance updates to 25,000, and after closing Settings the account menu also shows 25,000 credits.
