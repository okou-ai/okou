# Chat composer connector accounts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-accounts.test.tsx](chat-composer-connector-accounts.test.tsx).

## chat-composer-connector-accounts-001

Original test `Configuration attention keeps the builtin default out of healthy account fallbacks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L122).

- **Given** A chat uses an Acme built-in connector with a default Work account missing its required region and a Personal account whose authorization has expired.
- **When** The user opens the account chooser for the chat, with Personal already selected.
- **Then** Work and the Use default option are marked reconnect required; Personal remains selected and is marked as having no usable account.

## chat-composer-connector-accounts-002

Original test `Configuration attention keeps the custom default out of healthy account fallbacks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L122).

- **Given** A chat uses a custom Acme connector with a default Work account missing its required region and a Personal account whose authorization has expired.
- **When** The user opens the account chooser for the chat, with Personal already selected.
- **Then** Work and the Use default option are marked reconnect required; Personal remains selected and is marked as having no usable account.

## chat-composer-connector-accounts-003

Original test `A pending connector authorization does not borrow the other chat agent's access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L298).

- **Given** Two open chats belong to different agents. The other agent has Slack access, but its authorization request is still pending; the current agent does not have Slack access.
- **When** The user opens each chat's connector controls before and after the other agent's authorization completes.
- **Then** Before completion, Add Slack is enabled for the current agent, while the other agent shows neither Add Slack nor Remove Slack. Once authorization completes, Remove Slack is enabled for the other agent.

## chat-composer-connector-accounts-004

Original test `Removing a connector updates only the selected chat agent's access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L312).

- **Given** Two open chats belong to different agents, and only the other agent has Slack access.
- **When** The user removes Slack from the other agent's chat, then opens the current agent's connector controls.
- **Then** The other agent's controls show Add Slack, and the current agent still shows Add Slack. The removal updates only the other agent's access.

## chat-composer-connector-accounts-005

Original test `Carry a connector account choice into a new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L331).

- **Given** A user starts a new chat with GitHub authorized and Work as the default account; Personal is another available account.
- **When** The user selects Personal, closes and reopens the connector controls, then sends a message.
- **Then** Personal remains selected after reopening, and the new chat request carries the Personal account selection into the created chat.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); this scenario has no upstream test in the parent commit, because its upstream test was already removed in #48841. Rebuild this scenario starting the new chat at `/`.

## chat-composer-connector-accounts-006

Original test `An unavailable account keeps the new-chat draft and attachments (edited while creating: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L387).

- **Given** A user starts a new chat, selects Personal for GitHub, enters a message, and attaches a file. No edits are made while chat creation is pending.
- **When** Sending fails because the selected account is unavailable; the user chooses Use default and retries.
- **Then** The user stays on the new-chat page with the original message and attachment retained, and no message is sent on the failed attempt. The retry creates a chat without an explicit account selection and sends the original message with the attachment.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `An unavailable account keeps the new-chat draft and attachments (edited while creating: %s)` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L111)). Rebuild this scenario starting the new chat at `/`; the failed attempt keeps the user on `/`.

## chat-composer-connector-accounts-007

Original test `An unavailable account keeps the new-chat draft and attachments (edited while creating: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L387).

- **Given** A user starts a new chat, selects Personal for GitHub, enters a message, and attaches a file.
- **When** Sending is pending and the user edits the message; creation then fails because the selected account is unavailable. The user chooses Use default and retries.
- **Then** The user stays on the new-chat page with the newer message and attachment retained, and no message is sent on the failed attempt. The retry creates a chat without an explicit account selection and sends the newer message with the attachment.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `An unavailable account keeps the new-chat draft and attachments (edited while creating: %s)` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L111)). Rebuild this scenario starting the new chat at `/`; the failed attempt keeps the user on `/`.

## chat-composer-connector-accounts-008

Original test `Resending an unconfirmed creation reuses its chat and event identities`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L521).

- **Given** A user starts a new chat, selects Personal for GitHub, and enters a message. The first create request receives an internal error after the server may have committed the chat.
- **When** The user retries sending after seeing that the create response was interrupted.
- **Then** The message is sent and the user navigates to the chat identified by the original client chat ID. The retry repeats the same create request, preserving its chat and event identities.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `Resending an unconfirmed creation reuses its chat and event identities` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L258)). Rebuild this scenario starting the new chat at `/`.

## chat-composer-connector-accounts-009

Original test `Choose an account for a custom MCP connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L593).

- **Given** A chat has a custom DeepWiki MCP connector with Team as its default account and Personal as another account.
- **When** The user selects Personal in the account chooser and reopens the chooser.
- **Then** The chat selection is updated to Personal, and the chooser offers Use default with Team.

## chat-composer-connector-accounts-010

Original test `Choose which connector account a chat uses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx#L657).

- **Given** A chat has GitHub with Work as its default account and Personal as another account.
- **When** The user selects Personal, then selects Use default.
- **Then** The connector control first shows Personal selected and GitHub remains available to add; after choosing Use default it returns to the unselected-account label. No connector authorization changes, and the chat's GitHub account selection is cleared.
