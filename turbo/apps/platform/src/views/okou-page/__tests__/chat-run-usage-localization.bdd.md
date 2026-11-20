# Chat run usage localization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-usage-localization.test.tsx](chat-run-usage-localization.test.tsx).

## chat-run-usage-localization-001

Original test `Return to the conversation that started a chat message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-usage-localization.test.tsx#L41).

- **Given** A completed chat message has source metadata for Slack, Feishu, Teams, GitHub, Telegram, or agentphone; some sources include an external URL and some identify a chat rather than a message.
- **When** The user opens the conversation and checks its source links and labels.
- **Then** Each supplied external URL is linked in a new tab with its source-specific label. Telegram and Teams chat links use “Open chat,” while Telegram message links use “Open message”; an agentphone source without a URL is labeled “iMessage” without a link.

## chat-run-usage-localization-002

Original test `Label existing Email messages from their raw context without adding a mail-provider link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-usage-localization.test.tsx#L180).

- **Given** An existing message has raw Email context, while a later message has Web context.
- **When** The user views the messages and copies the Email-context message.
- **Then** The Email message is labeled “Email” without a mail-provider link, while the Web message is not labeled Email. The copied rich message preserves the original subject and body as user text.

## chat-run-usage-localization-003

Original test `Show the canonical Lark source with a chat link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-usage-localization.test.tsx#L264).

- **Given** A message has a canonical Lark source and the URL https://open.larksuite.com/chat/ch_123.
- **When** The conversation displays the source.
- **Then** The source is labeled “Lark” and links to the supplied URL with the accessible label “Open original chat in Lark”.

## chat-run-usage-localization-004

Original test `Show the historical Feishu source with a Lark ch…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-usage-localization.test.tsx#L264).

- **Given** A message has a historical Feishu source and the URL https://applink.larksuite.com/client/chat/open?openChatId=oc_123.
- **When** The conversation displays the source.
- **Then** The source is labeled “Lark” and links to the supplied URL with the accessible label “Open original chat in Lark”.

## chat-run-usage-localization-005

Original test `Show the current usage settlement on the correct run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-usage-localization.test.tsx#L306).

- **Given** Two completed runs have usage records: the first has an earlier settlement of 5 credits and a later replacement of 999 credits, and the second has 3 credits from Slack.
- **When** The user views both runs and opens the second run’s usage details.
- **Then** The first run shows its current 8-credit usage, not the earlier 5-credit record or the replacement record’s 999-credit total. The second run shows 3 credits attributed to Slack, with no GPT 5.6 Sol usage shown in its details.
