# Chat composer model selection

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-model-selection.test.tsx](chat-composer-model-selection.test.tsx).

## chat-composer-model-selection-001

Original test `Temporarily choose a model for a new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L139).

- **Given** A new chat defaults to Claude Fable 5.1 and offers Claude Sonnet 5.
- **When** The user selects Claude Sonnet 5, then chooses “Use this for future chats.”
- **Then** Selecting the model alone does not update the saved preference, and the chat is marked as temporarily switched. Choosing the future-chat option saves Claude Sonnet 5 with high effort; after the preference-change event, the temporary-switch notice disappears and the picker shows Claude Sonnet 5.

## chat-composer-model-selection-002

Original test `Follow model preference changes made in another session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L192).

- **Given** A new chat is showing Claude Fable 5.1, with Claude Opus 5.5 available.
- **When** Another session changes the default model to Claude Opus 5.5 and announces a preference change that includes an additional, unknown preference kind.
- **Then** The new-chat model picker changes to Claude Opus 5.5.

## chat-composer-model-selection-003

Original test `Switch chat models immediately and adjust Fast in the same panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L211).

- **Given** A new chat offers GPT 5.6 Sol and GPT 5.6 Luna.
- **When** The user selects GPT 5.6 Luna and enables Fast mode in the same panel, then selects GPT 5.6 Luna again.
- **Then** The picker immediately shows GPT 5.6 Luna, the panel shows 2.5× subscription usage, and the control shows xHigh with Fast enabled. Selecting the already-selected model leaves Fast enabled.

## chat-composer-model-selection-004

Original test `Choose effort for a new chat and keep Fast independent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L244).

- **Given** A new chat uses GPT 5.6 Sol with Max effort; the user is preparing a message.
- **When** The user changes effort from Max down to Low and back through Medium, High, xHigh, and Max, enables Fast, and sends the message.
- **Then** Fast can be enabled without changing Max effort, and the new chat is created with Max reasoning effort and priority service tier.

## chat-composer-model-selection-005

Original test `Start a new chat on the route default when the saved effort is no longer offered`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L293).

- **Given** A new chat has a saved Max preference for Claude Sonnet 5, but that route currently offers only low, medium, high, and extra efforts.
- **When** The user sends a message using the displayed route-default effort.
- **Then** The picker displays High, the task completes, and thread creation omits an explicit reasoning effort rather than sending the no-longer-supported Max preference.

## chat-composer-model-selection-006

Original test `Select the default effort on an existing thread without changing Fast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L361).

- **Given** An existing GPT 5.6 Sol thread is at High effort with Fast enabled.
- **When** The user raises the effort to xHigh and then Max.
- **Then** Max is selected and the update keeps Fast enabled.

## chat-composer-model-selection-007

Original test `Keep independent effort selections when changing models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L406).

- **Given** A new chat offers Claude Sonnet 5, GPT 5.6 Sol, and GPT 5.6 Luna, with independent effort choices per model.
- **When** The user changes Claude Sonnet 5 from High to Extra, switches to GPT 5.6 Sol and then GPT 5.6 Luna, and returns to Claude Sonnet 5.
- **Then** GPT 5.6 Sol retains Max, GPT 5.6 Luna retains xHigh, and returning to Claude Sonnet 5 restores Extra.

## chat-composer-model-selection-008

Original test `Cap gpt-5.6-luna at xHigh even with a saved Max preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L456).

- **Given** An existing gpt-5.6-luna thread has a saved Max effort preference, but this model is capped at xHigh.
- **When** The user reaches the end of the effort range, attempts to move higher, then moves down and back to the end.
- **Then** The initial displayed effort is xHigh with no update; moving higher cannot exceed xHigh. Moving down selects High, and returning to the end updates the effort to xHigh.

## chat-composer-model-selection-009

Original test `Cap gpt-6-luna at xHigh even with a saved Max preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L456).

- **Given** An existing gpt-6-luna thread has a saved Max effort preference, but this model is capped at xHigh.
- **When** The user reaches the end of the effort range, attempts to move higher, then moves down and back to the end.
- **Then** The initial displayed effort is xHigh with no update; moving higher cannot exceed xHigh. Moving down selects High, and returning to the end updates the effort to xHigh.

## chat-composer-model-selection-010

Original test `Show the Pi fallback without overwriting a saved native preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L495).

- **Given** An existing GPT 5.6 Sol thread has a saved native effort preference of Ultra, which Pi cannot display natively.
- **When** The user opens the model panel.
- **Then** The effort control displays Pi’s Max fallback, and opening the panel causes no update to the saved native preference.

## chat-composer-model-selection-011

Original test `Save the preferred effort for future chats when Pi displays a fallback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L516).

- **Given** A new chat has a saved Ultra preference for GPT 5.6 Sol, which Pi displays as Max.
- **When** The user switches from Claude Sonnet 5 to GPT 5.6 Sol and chooses to use it for future chats.
- **Then** The panel displays Max as the fallback, while the future-chat preference update preserves Ultra for GPT 5.6 Sol.

## chat-composer-model-selection-012

Original test `Follow model-scoped effort changes made in another session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L558).

- **Given** An existing Claude Sonnet 5 thread is at High effort.
- **When** Another session sends model-selection updates for that thread in the order Low, Medium, High, Extra, and Max.
- **Then** The displayed effort follows each update in order, ending at Max.

## chat-composer-model-selection-013

Original test `Offer gpt-6-astra efforts for codex-oauth-token with Pi enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L615).

- **Given** An existing chat offers gpt-6-astra through a codex-oauth-token provider, with Pi enabled.
- **When** The user moves the effort control to its first and then last position.
- **Then** The available effort range runs from Low to Ultra.
