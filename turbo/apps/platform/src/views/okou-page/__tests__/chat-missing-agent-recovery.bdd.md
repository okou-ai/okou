# Chat missing agent recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-missing-agent-recovery.test.tsx](chat-missing-agent-recovery.test.tsx).

## chat-missing-agent-recovery-001

Original test `A missing agent falls back to the recorded default agent that is visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L48).

- **Given** The requested agent is missing, while the recorded default and another agent are both visible.
- **When** The user opens the missing agent’s chat URL.
- **Then** The user is redirected to the recorded default agent’s chat.

## chat-missing-agent-recovery-002

Original test `A missing agent never falls back to a default the user cannot reach`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L56).

- **Given** The requested agent is missing, the recorded default is not reachable, and another agent is visible.
- **When** The user opens the missing agent’s chat URL.
- **Then** The user is redirected to the visible agent’s chat, not the unreachable default.

## chat-missing-agent-recovery-003

Original test `A missing agent falls back to a visible agent when no default is recorded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L64).

- **Given** The requested agent is missing, no default is recorded, and another agent is visible.
- **When** The user opens the missing agent’s chat URL.
- **Then** The user is redirected to the visible agent’s chat.

## chat-missing-agent-recovery-004

Original test `A missing agent with no visible agent and no recorded default opens home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L72).

- **Given** The requested agent is missing, no agents are visible, and no default is recorded.
- **When** The user opens the missing agent’s chat URL.
- **Then** The user is redirected home.

## chat-missing-agent-recovery-005

Original test `A missing agent with no visible agent opens the agent list instead of bouncing through home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L80).

- **Given** The requested agent is missing, no agents are visible, and the recorded default is unreachable.
- **When** The user opens the missing agent’s chat URL.
- **Then** The user is redirected to the agent list rather than home, avoiding a redirect loop.

## chat-missing-agent-recovery-006

Original test `A resolvable agent still opens its chat page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-missing-agent-recovery.test.tsx#L90).

- **Given** The requested agent is visible and named Scout, and is recorded as the default.
- **When** The user opens that agent’s chat URL.
- **Then** The chat page remains open with Scout in the page title and an enabled message textbox.
