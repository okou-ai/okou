# Chat thread header actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thread-header-actions.test.tsx](chat-thread-header-actions.test.tsx).

## chat-thread-header-actions-001

Original test `Keep menu pin changes responsive across resize and save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L119).

- **Given** A chat thread is open on desktop. Pin and unpin requests can be delayed, and the pin request has not yet completed.
- **When** Choose Pin chat, resize to mobile and back to desktop, then choose Unpin chat before the pin request finishes.
- **Then** The header adapts across both resizes, and the menu reflects the pending pin change. After the pin request completes, the thread title updates from a later server event and Pin chat is available again.

## chat-thread-header-actions-002

Original test `Keep Share and More in the header and match the sidebar menu order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L194).

- **Given** A chat thread is open on desktop with a draft email available.
- **When** Inspect the header actions and open More actions, then choose Rename chat.
- **Then** The header actions appear in the order Share messages, Manage emails, Artifacts and chats, and More actions, with a Back to chats control. The menu lists Pin chat, Rename chat, Mute chat, Archive chat, Automations, and Open browser in that order; the rename dialog starts with the current thread title.

## chat-thread-header-actions-003

Original test `Keep primary icon actions accessible and open emails from the desktop menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L247).

- **Given** A chat thread is open on mobile.
- **When** Inspect the primary header actions and More actions, open Manage emails, close the email dialog, and then open Automations from the menu.
- **Then** Share messages, Artifacts and chats, and More actions have accessible names. The menu lists Automations, Manage emails, and Open browser; opening emails closes the menu, and closing the dialog returns focus to More actions. The Automations panel opens.

## chat-thread-header-actions-004

Original test `Archive from the mobile header and return to the thread's agent before saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L281).

- **Given** A chat thread is open with Single Agent disabled, and its archive request is still pending.
- **When** Choose Archive chat from the mobile More actions menu.
- **Then** The app leaves the thread for the thread agent's chat page before the archive request completes. The thread content is no longer shown, and the request is not aborted when the user leaves.

## chat-thread-header-actions-005

Original test `Archive from the mobile header and return to My Okou's chat page before saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L281).

- **Given** A chat thread is open with Single Agent enabled, and its archive request is still pending.
- **When** Choose Archive chat from the mobile More actions menu.
- **Then** The app leaves the thread for My Okou's chat page before the archive request completes. The thread content is no longer shown, and the request is not aborted when the user leaves.

## chat-thread-header-actions-006

Original test `Undo a header archive from its toast and return to the thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L324).

- **Given** A chat thread is open on mobile and archiving succeeds.
- **When** Archive the thread and choose Undo from the confirmation toast.
- **Then** The app returns to the thread, its content is visible again, and Archive chat is available in More actions.

## chat-thread-header-actions-007

Original test `Mute from the mobile header and unmute from the desktop header`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L396).

- **Given** A chat thread is open on mobile and mute and unmute requests succeed.
- **When** Mute the thread, then resize to desktop and choose Unmute chat in the header.
- **Then** The thread remains open after muting and displays a mute confirmation. Unmute chat appears in the menu and then as a desktop header action; choosing it displays an unmute confirmation and removes the Unmute chat action.

## chat-thread-header-actions-008

Original test `Show the archive API error after leaving the thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L437).

- **Given** A chat thread is open on mobile and the archive service returns an error.
- **When** Choose Archive chat.
- **Then** The app shows the archive error after leaving the thread for the thread agent's chat page.

## chat-thread-header-actions-009

Original test `Unarchive from the mobile header and stay in the current thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L452).

- **Given** An archived chat thread is open on mobile and the unarchive request is pending.
- **When** Choose Unarchive chat and reopen More actions before the request completes.
- **Then** The app stays in the current thread, and Archive chat is disabled while unarchiving is pending. After the request succeeds, Archive chat is enabled and the thread content remains visible.

## chat-thread-header-actions-010

Original test `Stay in the archived thread and show the unarchive API error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L502).

- **Given** An archived chat thread is open on mobile and the unarchive service returns an error.
- **When** Choose Unarchive chat.
- **Then** The app stays in the current thread, keeps its content visible, and shows the unarchive error.

## chat-thread-header-actions-011

Original test `Open linked automations from the mobile menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L520).

- **Given** A chat thread is open on mobile with a linked automation available.
- **When** Open More actions and choose Automations.
- **Then** The menu includes Automations, and the Automations panel opens with the linked automation visible.

## chat-thread-header-actions-012

Original test `Retain message selection and restore mobile actions after sharing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L569).

- **Given** A chat thread is open on mobile with messages available for sharing.
- **When** Start sharing, select one message group, cancel sharing, and open the thread icon picker.
- **Then** Sharing starts with zero selected and hides More actions; selecting a group shows one selected. After cancellation, Share messages and More actions return, and the icon picker opens with emoji search available.

## chat-thread-header-actions-013

Original test `Show the existing API error without undoing an optimistic pin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L587).

- **Given** A chat thread is open on desktop and the pin service returns an error.
- **When** Choose Pin chat and then reopen More actions after the error appears.
- **Then** The app shows the pin error but retains the optimistic pinned state, with Unpin chat enabled.

## chat-thread-header-actions-014

Original test `Continue saving the next pin change after an earlier request fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-header-actions.test.tsx#L603).

- **Given** A chat thread is open on mobile. The first pin request is pending and will fail, and the following unpin request will also fail.
- **When** Choose Pin chat, choose Unpin chat before the pin request completes, then allow both requests to finish.
- **Then** The app shows both pin and unpin errors, and Pin chat is enabled afterward, showing that the next pin change was sent despite the earlier failure.

### Batch 42 disposition

- `chat-thread-header-actions-001` remains unaccepted. The desktop More menu exposes Automations, Manage emails and Open browser. Its starting Pin action is on mobile. Pinning via the sidebar would change the entry point.
- `chat-thread-header-actions-002` remains unaccepted. Even with a thread draft email, the desktop More menu has those three items. The frozen Back control, primary email action and Rename menu path belong to mobile.
- `chat-thread-header-actions-003` remains unaccepted. On mobile, Manage emails is primary. More contains Pin, Rename, Mute, Archive, Automations and Open browser. The frozen three-item menu, email launch and focus-return sequence belong to desktop.
- `chat-thread-header-actions-008` remains unaccepted. Hold the archive denial until the page leaves the thread. The app is at / when the error appears. The frozen agent-specific chat destination was retired with the workspace-chat changes.
