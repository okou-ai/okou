# Chat message visualization preferences

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-visualization-preferences.test.tsx](chat-message-visualization-preferences.test.tsx).

## chat-message-visualization-preferences-001

Original test `Sent visualization choices are grouped, concise, and only shown when selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-visualization-preferences.test.tsx#L54).

- **Given** Sent messages cover selected presentation and chart preferences, output-only and chart-only choices, eight chart types, defaults, empty selections, explicit report, and legacy preference text.
- **When** The user opens the chat.
- **Then** Selected choices appear in concise grouped summaries: presentation with Bar +2, presentation alone, charts alone, and all eight chart names summarized as Bar +7. Explicit report appears as “Report”; legacy website and chart preferences appear as “Website” with two charts, while default report with charts shows only the charts. Defaults and empty choices produce no summary, and raw preference text is absent from the selected message.
