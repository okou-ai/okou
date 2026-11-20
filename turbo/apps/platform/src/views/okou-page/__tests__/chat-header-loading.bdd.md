# Chat header loading

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-header-loading.test.tsx](chat-header-loading.test.tsx).

## chat-header-loading-001

Original test `Keep every desktop header action for a chat without mail or automations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L177).

- **Given** A desktop chat has no mail or automations.
- **When** I view its header actions.
- **Then** The header still offers Share messages, Artifacts and chats, and More actions.

## chat-header-loading-002

Original test `Open mail and automation empty states in a chat with neither (desktop=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L190).

- **Given** A desktop chat has no mail and no automations.
- **When** I open Manage emails and then Automations.
- **Then** The email list says “No emails yet” and explains that chat emails will appear there; it has no subject-or-sender search. The automations pane says “No automations yet” and explains that chat automations will appear there.

## chat-header-loading-003

Original test `Open mail and automation empty states in a chat with neither (desktop=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L190).

- **Given** A mobile chat has no mail and no automations.
- **When** I open Manage emails and then Automations from More actions.
- **Then** The email list says “No emails yet” and explains that chat emails will appear there; it has no subject-or-sender search. The automations pane says “No automations yet” and explains that chat automations will appear there.

## chat-header-loading-004

Original test `Open the destination's loading lists as soon as its pane replaces the previous chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L229).

- **Given** The previous chat is open, and the destination chat has mail and an automation whose reads are still pending.
- **When** I navigate to the destination and open its email list, then open its automations pane.
- **Then** The email list immediately shows a loading status without search or a count. Once mail loads, it shows the email, search, and a count of one; once automations load, it shows the destination’s schedule.

## chat-header-loading-005

Original test `Mark every header button as settling while the previous chat is still on screen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L266).

- **Given** A chat is open and its header actions are settled.
- **When** Navigation to another chat begins, but that chat’s details are still pending.
- **Then** The previous chat remains on screen, and each header action becomes busy and aria-disabled while remaining enabled for focus and without a disabled attribute.

## chat-header-loading-006

Original test `Show failed first mail and automation reads instead of empty states`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L309).

- **Given** The first mail and automation reads for a chat fail.
- **When** I open Manage emails and Automations.
- **Then** The email list reports “Unable to load emails,” not an empty state. The automations pane reports “Could not load automations,” not an empty state.

## chat-header-loading-007

Original test `Open the destination's browser from the mobile menu after navigating`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L331).

- **Given** A mobile user navigates to a destination chat, and its managed browser lookup returns not found.
- **When** I open More actions and choose Open browser.
- **Then** The Cloud browser pane opens with a link to the destination chat’s browser page.

## chat-header-loading-008

Original test `Let each pane open its own chat's mail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-header-loading.test.tsx#L357).

- **Given** Two chat panes are open: the previous chat has no mail, and the destination chat has mail.
- **When** I open Manage emails in each pane in turn.
- **Then** The previous chat’s email list shows “No emails yet”; the destination chat’s email list shows its current email.
