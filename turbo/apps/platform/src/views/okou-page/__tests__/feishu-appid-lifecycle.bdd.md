# Feishu appid lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-appid-lifecycle.test.tsx](feishu-appid-lifecycle.test.tsx).

## feishu-appid-lifecycle-001

Original test `feishu app validation preserves a newly opened setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-appid-lifecycle.test.tsx#L17).

- **Given** A Feishu bot setup has an app ID and secret entered, and app-ID validation is still pending.
- **When** The user leaves for Feishu bots, opens a new bot setup, then the earlier validation completes and the user advances.
- **Then** The new setup remains open, and its App ID and App Secret fields are empty.

## feishu-appid-lifecycle-002

Original test `lark app validation preserves a newly opened setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-appid-lifecycle.test.tsx#L17).

- **Given** A Lark bot setup has an app ID and secret entered, and app-ID validation is still pending.
- **When** The user leaves for Lark bots, opens a new bot setup, then the earlier validation completes and the user advances.
- **Then** The new setup remains open, and its App ID and App Secret fields are empty.
