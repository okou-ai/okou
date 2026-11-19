# Chat composer model catalog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-model-catalog.test.tsx](chat-composer-model-catalog.test.tsx).

## chat-composer-model-catalog-001

Original test `Offer the active catalog models in catalog order with catalog names`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-catalog.test.tsx#L56).

- **Given** A user is composing a new chat with available models GPT 6 Luna, Claude Fable 5, and Claude Sonnet 5.
- **When** They open the model chooser.
- **Then** The chooser lists Auto, Claude Sonnet 5, and GPT 6 Luna in that order, using catalog names.

## chat-composer-model-catalog-002

Original test `Offer Auto from canonical available-model and catalog responses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-catalog.test.tsx#L73).

- **Given** A user is composing a new chat with canonical catalog and available-model responses that include Auto and GPT 6 Luna, and the preference is Auto.
- **When** They open the model chooser.
- **Then** The chooser lists Auto and GPT 6 Luna.

## chat-composer-model-catalog-003

Original test `Show the replacement for a thread pinned to a retired model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-catalog.test.tsx#L108).

- **Given** An existing chat is pinned to the retired model Claude Fable 5, and Claude Fable 5.1 is available.
- **When** The user opens the chat.
- **Then** The composer’s model control shows Claude Fable 5.1.

## chat-composer-model-catalog-004

Original test `Resolve a member preference of a retired model to its replacement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-catalog.test.tsx#L121).

- **Given** A user’s model preference is the retired model DeepSeek V4 Pro, and GPT 6 Luna and Claude Sonnet 5 are available for a new chat.
- **When** They open the new-chat composer.
- **Then** The composer’s model control shows GPT 6 Luna.
