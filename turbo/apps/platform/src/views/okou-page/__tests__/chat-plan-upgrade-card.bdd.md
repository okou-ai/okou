# Chat plan upgrade card

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-plan-upgrade-card.test.tsx](chat-plan-upgrade-card.test.tsx).

## chat-plan-upgrade-card-001

Original test `Keep the general plans action for an existing paid workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-plan-upgrade-card.test.tsx#L24).

- **Given** A paid Pro workspace has an existing chat response containing a Compare plans link.
- **When** The user clicks Compare plans on the upgrade card.
- **Then** The “Choose a plan” dialog becomes visible.
