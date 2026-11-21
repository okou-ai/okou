# Chat member model route

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-member-model-route.test.tsx](chat-member-model-route.test.tsx).

## chat-member-model-route-001

Original test `Shows GPT 5.6 Sol in the model panel as just its model name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L38).

- **Given** A new chat has GPT 5.6 Sol selected and both GPT 5.6 Sol and Claude Sonnet 5 are available.
- **When** The user opens the model panel and locates GPT 5.6 Sol.
- **Then** The option is enabled and its visible label is exactly “GPT 5.6 Sol,” without extra provider or model details.

## chat-member-model-route-002

Original test `Shows Claude Sonnet 5 in the model panel as just its model name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L38).

- **Given** A new chat has GPT 5.6 Sol selected and both GPT 5.6 Sol and Claude Sonnet 5 are available.
- **When** The user opens the model panel and locates Claude Sonnet 5.
- **Then** The option is enabled and its visible label is exactly “Claude Sonnet 5,” without extra provider or model details.

## chat-member-model-route-003

Original test `Uses the effective subscription for reasoning and Fast guidance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L65).

- **Given** A new chat uses GPT 5.6 Sol with Max reasoning effort and Fast mode.
- **When** The user opens the model settings panel.
- **Then** The panel shows Max effort and Fast mode checked, displays Lower usage and Higher usage guidance, and states that usage is 2.5× the subscription usage.

## chat-member-model-route-004

Original test `Reconnects the personal subscription used by the selected model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L91).

- **Given** A new chat uses GPT 5.6 Sol, whose personal subscription requires reconnection because its refresh token expired. The user has typed “Do not send until reconnected.”
- **When** The user opens model configuration to reconnect Codex.
- **Then** Sending is disabled, the reconnect dialog displays code “C342-4000,” and reconnection targets the personal subscription used by GPT 5.6 Sol. The draft remains in the composer.

## chat-member-model-route-005

Original test `Refreshes the account target on explicit reconnect after a remote account switch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L146).

- **Given** A new chat uses GPT 5.6 Sol and has loaded the original account. After a remote account switch, the user types “Preserve this draft during reconnect”; the model update arrives, but the cached account list has not been refreshed.
- **When** The user explicitly opens model configuration to reconnect Codex.
- **Then** The reconnect flow refreshes the account target, displays code “NEXT-3424,” and targets the new account rather than the original one. The draft remains in the composer.
