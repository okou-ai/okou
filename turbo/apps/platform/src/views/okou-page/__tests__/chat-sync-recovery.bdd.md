# Chat sync recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-sync-recovery.test.tsx](chat-sync-recovery.test.tsx).

## chat-sync-recovery-001

Original test `Ordinary notifications update a hidden chat tab through direct`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L115).

- **Given** A chat is open with an earlier title and a previously loaded reply.
- **When** While the browser tab is hidden, an ordinary notification arrives after the thread is renamed.
- **Then** The chat list shows “Updated while away” and no longer shows “Earlier title”; the update remains visible after the tab becomes visible.

## chat-sync-recovery-002

Original test `Ordinary notifications update a hidden chat tab through message-port`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L115).

- **Given** A chat is open with an earlier title and a previously loaded reply.
- **When** While the browser tab is hidden, an ordinary notification arrives after the thread is renamed using the message-port transport.
- **Then** The chat list shows “Updated while away” and no longer shows “Earlier title”; the update remains visible after the tab becomes visible.

## chat-sync-recovery-003

Original test `A realtime continuity gap catches up without another chat notification`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L147).

- **Given** A chat is open with an earlier title and a previously loaded reply.
- **When** The chat thread changes and a realtime connection continuity gap occurs, without another chat notification.
- **Then** The chat list shows “Updated while away,” and the missed reply “Reply received while away” appears.

## chat-sync-recovery-004

Original test `A connection gap catches up Project changes without another notification at /chats/b0000000-0000-4000-a000-00000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L175).

- **Given** The app is open on the chat run page, showing “Earlier Project” and “Retired Project.”
- **When** Project changes rename the first project, delete the second, and create “New Project” across a connection gap, with no further notification.
- **Then** “Renamed Project” and “New Project” appear, while “Earlier Project” and “Retired Project” disappear; the previously loaded chat reply remains visible and the route stays on the chat run page.

## chat-sync-recovery-005

Original test `A credential gap catches up Project changes without another notification at /chats/b0000000-0000-4000-a000-00000000…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L175).

- **Given** The app is open on the chat run page, showing “Earlier Project” and “Retired Project.”
- **When** Project changes rename the first project, delete the second, and create “New Project” across a credential gap, with no further notification.
- **Then** “Renamed Project” and “New Project” appear, while “Earlier Project” and “Retired Project” disappear; the previously loaded chat reply remains visible and the route stays on the chat run page.

## chat-sync-recovery-006

Original test `A credential gap catches up Project changes without another notification at /`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L175).

- **Given** The app is open at the home route, showing “Earlier Project” and “Retired Project.”
- **When** Project changes rename the first project, delete the second, and create “New Project” across a credential gap, with no further notification.
- **Then** “Renamed Project” and “New Project” appear, while “Earlier Project” and “Retired Project” disappear; the chat reply is not shown and the route stays at the home page.
