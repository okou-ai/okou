# Feishu token lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-token-lifecycle.test.tsx](feishu-token-lifecycle.test.tsx).

## feishu-token-lifecycle-001

Original test `feishu token setup preserves a newer bot draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-token-lifecycle.test.tsx#L19).

- **Given** A Feishu bot setup is submitting credentials for a first bot, and the setup response is delayed.
- **When** While that request is pending, the user starts a second bot draft and enters a different app ID and secret; then the first request completes.
- **Then** The second draft's app ID and secret remain unchanged after the earlier setup response arrives.

## feishu-token-lifecycle-002

Original test `lark token setup preserves a newer bot draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-token-lifecycle.test.tsx#L19).

- **Given** A Lark bot setup is submitting credentials for a first bot, and the setup response is delayed.
- **When** While that request is pending, the user starts a second bot draft and enters a different app ID and secret; then the first request completes.
- **Then** The second draft's app ID and secret remain unchanged after the earlier setup response arrives.
