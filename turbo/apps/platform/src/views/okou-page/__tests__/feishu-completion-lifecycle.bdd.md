# Feishu completion lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-completion-lifecycle.test.tsx](feishu-completion-lifecycle.test.tsx).

## feishu-completion-lifecycle-001

Original test `feishu setup completion preserves a newer bot draft and its page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-completion-lifecycle.test.tsx#L19).

- **Given** A Feishu bot installation is being marked complete while the user opens its setup again and enters a new App Secret.
- **When** The earlier completion request resolves.
- **Then** The user remains on that bot’s setup page, no dialog appears, and the newer App Secret remains entered.

## feishu-completion-lifecycle-002

Original test `lark setup completion preserves a newer bot draft and its page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-completion-lifecycle.test.tsx#L19).

- **Given** A Lark bot installation is being marked complete while the user opens its setup again and enters a new App Secret.
- **When** The earlier completion request resolves.
- **Then** The user remains on that bot’s setup page, no dialog appears, and the newer App Secret remains entered.
