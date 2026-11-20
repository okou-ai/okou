# Chat composer inline template replacement

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-inline-template-replacement.test.tsx](chat-composer-inline-template-replacement.test.tsx).

## chat-composer-inline-template-replacement-001

Original test `Replacing an inline template preserves a previously sent reference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-inline-template-replacement.test.tsx#L23).

- **Given** A chat thread has a previously sent reference to the first presentation template, and its composer draft contains that same inline template.
- **When** The user opens the inline template’s picker and selects the third presentation template.
- **Then** The composer contains exactly one inline template, showing the replacement template, while the previously sent reference remains visible with the original template’s title.
