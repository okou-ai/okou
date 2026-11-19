# Chat composer model recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-model-recovery.test.tsx](chat-composer-model-recovery.test.tsx).

## chat-composer-model-recovery-001

Original test `Connect Codex before sending with a personal route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-recovery.test.tsx#L152).

- **Given** A user has a new chat with GPT 5.6 Luna selected, but its personal Codex route is unavailable, and the user has drafted “Hello.”
- **When** They try to send and open model configuration, then connect Codex using the offered device code and approve the login.
- **Then** Sending is disabled while the route is unavailable. The connection dialog shows code ABCD-EFGH and the device authorization link; copying the code writes it to the clipboard. After approval, “ChatGPT connected” appears and model configuration is no longer offered.

## chat-composer-model-recovery-002

Original test `Complete Claude Code login from a blocked message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-recovery.test.tsx#L241).

- **Given** A user has a new chat with Claude Opus 5.5 selected, but its personal Claude Code route is unavailable, and the user has drafted “Explain this failure.”
- **When** They try to send, open model configuration, enter an authorization code, and connect Claude.
- **Then** Sending is disabled while the route is unavailable. After login, “Claude connected” appears and model configuration is no longer offered.

## chat-composer-model-recovery-003

Original test `Reconnect the personal provider used by the selected model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-recovery.test.tsx#L304).

- **Given** A user has a new chat with GPT 5.6 Sol selected. Its matching active Codex account needs reconnection, while a separate matching account is inactive.
- **When** They open model configuration to reconnect Codex.
- **Then** A “Re-connect Codex” dialog appears. Reconnection starts for the active account, not the inactive one, and the dialog does not show the inactive account’s email.

## chat-composer-model-recovery-004

Original test `Reconnect Claude Code for an existing chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-recovery.test.tsx#L374).

- **Given** A user has an existing chat with Claude Opus 5.5 selected. Its matching active Claude Code account needs reconnection, while a separate matching account is inactive.
- **When** They open model configuration to reconnect Claude Code.
- **Then** A “Reconnect Claude” dialog appears. Reconnection starts for the active account, not the inactive one, and the dialog does not show the inactive account’s email.
