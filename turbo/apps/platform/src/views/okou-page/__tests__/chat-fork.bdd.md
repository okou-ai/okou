# Chat fork

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-fork.test.tsx](chat-fork.test.tsx).

## chat-fork-001

Original test `Fork keeps the source project`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L104).

- **Given** A source chat belongs to the Launch project and has unfinished notes in its composer.
- **When** I select “launch plan has three careful stages,” fork it, and send “Explore another launch plan.”
- **Then** A new chat is created in Launch, while the source stays in Launch, its composer notes remain, and I stay on the source chat.

## chat-fork-002

Original test `Fork keeps an unassigned source outside…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L104).

- **Given** A source chat is not assigned to a project and has unfinished notes in its composer.
- **When** I select “launch plan has three careful stages,” fork it, and send “Explore another launch plan.”
- **Then** A new chat is created outside Projects, the source remains outside Projects, its composer notes remain, and I stay on the source chat.

## chat-fork-003

Original test `Forward in legacy mode creates a chat o…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L104).

- **Given** A source chat belongs to the Launch project, single-agent mode is disabled, and its composer contains unfinished notes.
- **When** I select “launch plan has three careful stages,” forward it to Okou, and send “Explore another launch plan.”
- **Then** A new chat is created outside Projects, the source remains in Launch, its composer notes remain, and I stay on the source chat.

## chat-fork-004

Original test `F opens a Fork composer carrying the captured selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L172).

- **Given** A chat displays the passage “launch plan has three careful stages,” and single-agent mode is enabled.
- **When** I select the passage and press F.
- **Then** A Fork composer opens with the selected passage carried into it; I can enter “Focus on the launch risks.”

## chat-fork-005

Original test `F keeps the Forward target picker when single-agent mode is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L195).

- **Given** A chat displays the passage “launch plan has three careful stages,” and single-agent mode is disabled.
- **When** I select the passage and press F, then choose Okou as the forwarding target.
- **Then** The Forward target picker is used, and the selected passage appears in the message composer.

## chat-fork-006

Original test `Fork sends the selected passage and its source to a new personal chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L216).

- **Given** A chat contains “launch plan has three careful stages” and a separate unrelated answer, with unfinished notes in its composer.
- **When** I select the passage, fork it, and send “Explore the risks in a separate conversation.”
- **Then** A new chat receives the selected passage as feedback, cites the source run, and includes the written note but not the unrelated answer. The source composer notes remain.

## chat-fork-007

Original test `Forward sends the passage with its source thread to the chosen agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L262).

- **Given** A chat displays the passage “launch plan has three careful stages,” and single-agent mode is disabled.
- **When** I select the passage, forward it to Okou, and send “Share this with the launch team.”
- **Then** A new chat for the chosen agent receives the passage as feedback with the source run cited and includes the written note.
- **Upstream change** `4e5707de` (#49556) retires the Forward target picker (`Forward to` dialog and agent choice), so a selected passage can only be forked into a new personal chat with Okou, and removes this upstream test. Retire this scenario; the retained send behavior is covered by `chat-fork-006` (upstream `Fork sends the selected passage and its source to a new personal chat`, [Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L176)).
