# Chat list configuration

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-list-configuration.test.tsx](chat-list-configuration.test.tsx).

## chat-list-configuration-001

Original test `Enabling cloud browser replaces the Computer Use host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-configuration.test.tsx#L70).

- **Given** A conversation uses the Studio Mac computer host, and cloud-browser updates have not yet arrived from the server.
- **When** The user opens the computer connection menu, then the cloud-browser update arrives.
- **Then** Initially, Studio Mac is selected and Cloud browser is not. After the update, Cloud browser is selected and Studio Mac is not.

## chat-list-configuration-002

Original test `Conversation configuration arriving before creation is retained`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-configuration.test.tsx#L125).

- **Given** A conversation has not yet been created, but events arrive selecting GPT 5.6 Sol, setting priority service tier, and connecting Studio Mac; the later creation event names DeepSeek V4 Flash.
- **When** The user opens the agent chat and selects the newly created conversation from the sidebar.
- **Then** The conversation appears in the sidebar, and its composer shows GPT 5.6 Sol, Max, Fast. Studio Mac is selected as the computer host.

## chat-list-configuration-003

Original test `Service tier and Computer Use settings update independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-configuration.test.tsx#L178).

- **Given** The configured conversation is initially set to GPT 5.6 Sol, while a newer conversation appears above it in the sidebar. Priority-tier and Studio Mac settings arrive while remote updates are pending.
- **When** The user views the configured conversation before and after the remote updates arrive.
- **Then** Before the updates, the composer shows GPT 5.6 Sol and Studio Mac is not selected. Afterward, the composer shows GPT 5.6 Sol, Max, Fast and Studio Mac is selected; the sidebar order remains Newer conversation followed by Configured conversation.
