# Chat composer keyboard

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-keyboard.test.tsx](chat-composer-keyboard.test.tsx).

## chat-composer-keyboard-001

Original test `Send with the Enter key preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L142).

- **Given** A user is composing a new chat with the Enter-to-send preference.
- **When** They type “Prepare the launch summary” and press Enter.
- **Then** The prompt is sent, appears as a user message, and the agent is shown working.

## chat-composer-keyboard-002

Original test `Shift-Enter keeps an active chat's follow-up draft on two lines without sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L162).

- **Given** A chat already has an active run, and the user has the Enter-to-send preference.
- **When** They type “Keep this draft,” press Shift-Enter, then type “on two lines.”
- **Then** The editor retains the two-line draft and focus, and no prompt is sent.

## chat-composer-keyboard-003

Original test `Send with the command-key preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L195).

- **Given** A user is composing a new chat with the command-key send preference on a Linux user agent.
- **When** They type “Review the campaign,” press Enter, then type “before publishing.”
- **Then** Enter adds a second line and keeps the editor focused without sending. Pressing Control-Enter sends the combined two-line prompt, displays it as a user message, and shows the agent working.

## chat-composer-keyboard-004

Original test `Avoid sending while text composition is in progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L227).

- **Given** A user is composing “かな” with Enter-to-send enabled.
- **When** They press Enter during text composition, once without Control and once with Control.
- **Then** The text remains in the focused editor; no prompt is sent and no user message appears.

## chat-composer-keyboard-005

Original test `Use the appropriate Enter behavior on touch devices`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L264).

- **Given** A user is chatting on an Android touch device with Enter-to-send enabled and the software keyboard open.
- **When** They enter “Draft from the on-screen keyboard,” press Enter, and add “with a second line.”
- **Then** Enter inserts a new line without sending. After the software keyboard closes, Enter sends the combined prompt, which appears as a user message, and the agent is shown working. With the keyboard open again, Control-Enter sends “Send with the hardware shortcut” as a second prompt.

## chat-composer-keyboard-006

Original test `Treat whitespace as an empty message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L327).

- **Given** A new chat has an empty composer and a disabled Send button.
- **When** The user enters a single space.
- **Then** The placeholder disappears, but Send remains disabled and no prompt is sent.
