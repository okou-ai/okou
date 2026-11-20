# Agents page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agents-page.test.tsx](agents-page.test.tsx).

## agents-page-001

Original test `Unread indicators update after an indicator change (direct)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page.test.tsx#L91).

- **Given** The agents page shows a private agent without an unread indicator, and the public Research Agent is also listed.
- **When** An unread-indicator change arrives using the direct transport.
- **Then** The private agent gains a visible unread indicator. After switching to Public, the Research Agent also has a visible unread indicator.

## agents-page-002

Original test `Unread indicators update after an indicator change (message-port)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page.test.tsx#L91).

- **Given** The agents page shows a private agent without an unread indicator, and the public Research Agent is also listed.
- **When** An unread-indicator change arrives using the message-port transport.
- **Then** The private agent gains a visible unread indicator. After switching to Public, the Research Agent also has a visible unread indicator.

## agents-page-003

Original test `Agent visibility tabs show public creators without management data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page.test.tsx#L153).

- **Given** The agent list has a public Research Agent created by Alice and a private Private Ops agent created by Bob. Organization management data is unavailable, but public member data identifies Alice as Alice Admin with a profile image.
- **When** The user switches between Private and Public and hovers over the public Research Agent.
- **Then** Private shows Private Ops but not Research Agent, and Bob Builder is not shown. Public shows Research Agent but not Private Ops; hovering reveals Alice Admin and her profile image, without displaying the management-data failure message.
