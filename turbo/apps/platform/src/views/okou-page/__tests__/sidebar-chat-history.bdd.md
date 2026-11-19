# Sidebar chat history

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-chat-history.test.tsx](sidebar-chat-history.test.tsx).

## sidebar-chat-history-001

Original test `Browse a long sidebar chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L80).

- **Given** A chat history contains more conversations than fit in the sidebar, including archived context below the initial visible entries.
- **When** The user scrolls down to the archived context.
- **Then** Archived context becomes visible, Release plan is no longer visible, and no Load more control is shown.

## sidebar-chat-history-002

Original test `Delete a chat after reviewing the impact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L94).

- **Given** The user is viewing Release plan and the sidebar also lists Incident notes.
- **When** The user chooses Delete chat for Release plan, reviews the permanent-deletion warning, cancels, then confirms deletion.
- **Then** The warning says the chat will be permanently deleted, running tasks stopped immediately, linked automations paused, and the action cannot be undone. Cancel preserves Release plan; confirming shows Chat deleted, opens a new chat at /, and removes Release plan while Incident notes remains.

## sidebar-chat-history-003

Original test `Deleting the last chat opens a new chat (My Okou: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L154).

- **Given** My Okou is enabled and the only chat, Release plan, is open.
- **When** The user confirms deleting Release plan.
- **Then** Chat deleted appears and a new chat opens at / with a message box; no missing-chat error appears.

## sidebar-chat-history-004

Original test `Deleting the last chat opens a new chat (My Okou: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L154).

- **Given** My Okou is disabled and the only chat, Release plan, is open under the default agent.
- **When** The user confirms deleting Release plan.
- **Then** Chat deleted appears and a new chat opens at the default agent's chat page, /agents/{AGENT_ID}/chat, with a message box; no missing-chat error appears.

## sidebar-chat-history-005

Original test `Deleting another chat keeps the current chat open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L190).

- **Given** Release plan is open and Incident notes is another listed chat.
- **When** The user deletes Incident notes.
- **Then** Chat deleted appears, Release plan remains open with its message box, and Incident notes disappears from the sidebar.

## sidebar-chat-history-006

Original test `Reveal chat titles from whole-link pointer and keyboard intent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L223).

- **Given** The sidebar contains titles with text widths 234, 123, 530, and 170 pixels, each clipped to 160 pixels; their configured reveal durations are 925 ms, 0 ms, 3000 ms, and 780 ms respectively.
- **When** The user hovers each whole chat link and then focuses and blurs the 234-pixel title link with the keyboard.
- **Then** Hover reveals each title using its configured duration and stops revealing on pointer exit. Keyboard focus reveals the focused title for 925 ms, and blur stops the reveal.

## sidebar-chat-history-007

Original test `Filter unread conversations using indicator timestamps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L314).

- **Given** The sidebar has a pinned unread chat, an unread chat, the active Release plan chat, and an archived chat. Unread timestamps are supplied for the pinned and ordinary unread chats.
- **When** The user selects Unread from the chat-list menu.
- **Then** Only Pinned incident and Incident notes appear; Release plan and Archived context do not.

## sidebar-chat-history-008

Original test `Filter chats by Inbox, Unread, or Archived`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L383).

- **Given** The inbox contains Release plan and ✅ Shipped notes; Archived context is archived and read, and Waiting for review is archived and unread.
- **When** The user selects Unread, then Archived, then Inbox from the chat-list menu.
- **Then** Unread shows only Waiting for review and navigates to it. Archived shows Archived context followed by Waiting for review without changing that open chat. Inbox shows Release plan followed by ✅ Shipped notes and returns to Release plan. The check-mark emoji does not make a chat archived.

## sidebar-chat-history-009

Original test `Selecting a filter skips the chat open in the right pane`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L477).

- **Given** Release plan is open, with two archived chats and a sidebar selection pointing to one of them.
- **When** The user selects Archived from the chat-list menu.
- **Then** The sidebar skips the chat already open in the right pane and navigates to the other archived chat, Waiting for review.

## sidebar-chat-history-010

Original test `Mute and unmute a chat without hiding or reordering it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L503).

- **Given** Release plan and Quiet task appear in that order in the sidebar.
- **When** The user mutes Quiet task and then unmutes it.
- **Then** Muted appears for Quiet task while both chats remain visible in their original order; after unmuting, the Muted indicator disappears.

## sidebar-chat-history-011

Original test `Archive an unread chat without retaining its agent reminder or changing reading state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L548).

- **Given** Review later is unread, its agent has an unread reminder, and Mark all read is available.
- **When** The user archives Review later and then undoes the archive from the toast.
- **Then** Archiving shows Chat archived. and removes the agent's unread reminder without changing Review later's unread state or disabling Mark all read. Undo restores the chat's unread indicator and the agent's unread reminder; Mark all read remains available.

## sidebar-chat-history-012

Original test `Mute an unread chat with feedback and undo it from the toast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L611).

- **Given** Quiet task is unread in the sidebar.
- **When** The user mutes it and then chooses Undo from the confirmation toast.
- **Then** The toast says new replies will not show as unread or send push notifications, and the chat is marked Muted. Undo restores its Unread indicator.

## sidebar-chat-history-013

Original test `Unmute a chat without resurfacing replies that arrived while it was muted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L648).

- **Given** Quiet task is muted and the server reports it and Incident notes as unread.
- **When** The user opens Quiet task's menu and unmutes it.
- **Then** Mark unread is not offered for the muted chat. Chat unmuted appears; Quiet task has no unread or muted indicator, while Incident notes remains Unread.

## sidebar-chat-history-014

Original test `Switch from muted chats to Archived without losing filter state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L715).

- **Given** The muted-chat filter is active and includes Quiet task and Archived quiet task.
- **When** The user switches to Archived and then back to Muted.
- **Then** Archived shows Archived quiet task followed by Archived task; Muted again shows Quiet task followed by Archived quiet task.

## sidebar-chat-history-015

Original test `Switch from muted chats to Unmute without losing filter state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L735).

- **Given** The muted-chat filter lists Quiet task and Archived quiet task.
- **When** The user unmutes Quiet task from its chat menu.
- **Then** Only Archived quiet task remains in the muted list.

## sidebar-chat-history-016

Original test `Switch from muted chats to Unread without losing filter state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L744).

- **Given** The muted-chat filter is active and there are no unread chats.
- **When** The user switches to Unread.
- **Then** The sidebar reports No unread chats.

## sidebar-chat-history-017

Original test `Switch from muted chats to Inbox without losing filter state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L753).

- **Given** The muted-chat filter lists Quiet task and Archived quiet task; Release plan is in the inbox.
- **When** The user unmutes Quiet task, then switches to Inbox.
- **Then** The muted list first retains only Archived quiet task. Inbox then shows Release plan followed by Quiet task and does not show a Show all chats control.

## sidebar-chat-history-018

Original test `Show an empty muted filter after unmuting its last chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L773).

- **Given** The sidebar contains Release plan and the only muted chat, Quiet task.
- **When** The user filters to Muted and then unmutes Quiet task.
- **Then** The sidebar reports No muted chats and has no chat titles. Choosing Show all chats restores Release plan and Quiet task.

## sidebar-chat-history-019

Original test `Running indicators take precedence over the muted icon`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L805).

- **Given** Quiet task is muted but also has a running indicator.
- **When** The user views it in the sidebar.
- **Then** Running is shown and Muted is not shown.

## sidebar-chat-history-020

Original test `Hide the current chat after archiving it without changing its title`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L826).

- **Given** The current chat has no title and appears in the inbox as New chat.
- **When** The user archives it, opens archived chats, unarchives it, and returns to all chats.
- **Then** The inbox becomes empty and New chat disappears, while the current route stays unchanged. Archived chats shows New chat under Archived · Chats with Okou. Unarchiving empties the archived filter without changing the title; returning to all chats shows New chat and no empty-archive message.

## sidebar-chat-history-021

Original test `Archive and unarchive the current chat with the keyboard shortcut`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L882).

- **Given** Release plan is the current chat and its archive menu item advertises Ctrl+Shift+X and the Meta and Control shortcut variants.
- **When** The user presses Ctrl+Shift+X twice, first to archive and then to unarchive.
- **Then** The first press removes Release plan from the inbox, shows Your inbox is empty, and displays Chat archived. The second restores Release plan, removes the empty-inbox message, and displays Chat moved to Inbox.

## sidebar-chat-history-022

Original test `Undo an archive from its toast and explain the muted exception`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L930).

- **Given** Quiet task is muted and visible in the inbox.
- **When** The user archives Quiet task and chooses Undo from the toast.
- **Then** The toast explains that the chat is muted so new replies will not bring it back. Quiet task disappears from the inbox and Undo restores it.

## sidebar-chat-history-023

Original test `Find archived chats in All and Chats workspace search results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L958).

- **Given** Archived context is absent from the inbox while Release plan is visible.
- **When** The user searches the workspace for “archived context” and checks All, then Chats.
- **Then** Archived context appears in the results under both All and Chats.

## sidebar-chat-history-024

Original test `Find conversations by title in workspace search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1001).

- **Given** The workspace has conversations titled Incident notes, Research kickoff, and Support escalation; Support escalation is running.
- **When** The user opens workspace search with Ctrl+Shift+F, searches “research,” then searches “support” and selects Support escalation.
- **Then** Research kickoff appears without Support escalation for the first query. The second query shows Support escalation as a running result; selecting it closes search and sets the page title to Support escalation | Okou.

## sidebar-chat-history-025

Original test `Route New chat to the current agent and Chat to the default agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1062).

- **Given** Research conversation is open under Research Agent, while the labeled Chat link points to the default agent.
- **When** The user starts New chat from the chat-list header, then selects Chat from the navigation rail.
- **Then** New chat opens at /agents/{RESEARCH_AGENT_ID}/chat. Chat opens at /agents/{AGENT_ID}/chat and shows the chat composer.

## sidebar-chat-history-026

Original test `My Okou's header holds the toggle, search, New Project and list menu while New chat leads the list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1115).

- **Given** My Okou is enabled and Release plan is listed.
- **When** The user inspects the chat-list header, hovers Create Project, opens and cancels project creation, then selects Archived from the list menu.
- **Then** The header contains Hide chat list, Search workspace, Create Project, and Open chat list menu, with no agent heading. New chat leads the list and is the current page with the Meta+Shift+O and Control+Shift+O shortcuts. Hover reveals Create Project; selecting it opens a project-name field and Escape closes it. The menu can switch to Archived.

## sidebar-chat-history-027

Original test `My Okou's Chat link and new chat shortcut open its chat page at /`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1186).

- **Given** My Okou is enabled and an existing conversation is available; the user is viewing that conversation.
- **When** The user presses Ctrl+Shift+O, opens the existing conversation, then selects Chat in the navigation rail.
- **Then** The Chat link points to /. The shortcut opens / with the chat composer; selecting the existing conversation opens its chat route, and Chat returns to /.

## sidebar-chat-history-028

Original test `My Okou's Chat link returns a filtered chat list to the inbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1226).

- **Given** My Okou is enabled and the sidebar inbox contains Release plan while Archived context is archived.
- **When** The user switches the list to Archived, then selects Chat in the navigation rail.
- **Then** Archived context appears with an Archived heading. Chat returns to /, restores Release plan to the list, and clears the Archived heading.

## sidebar-chat-history-029

Original test `Mark all current-agent chats read from the chat-list menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1267).

- **Given** The current agent has Existing conversation and an unread Unread conversation. The chat-list menu offers Mark all read, Inbox, Unread, Archived, and Muted.
- **When** The user selects Unread, then chooses Mark all read from the menu.
- **Then** Unread initially shows only Unread conversation. Mark all read clears its unread state, shows No unread chats, and removes it from the list. The action is called for the current agent; Mark all read remains in the menu but is disabled when no unread chats remain.

## sidebar-chat-history-030

Original test `Mark the current conversation unread after navigating away`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1499).

- **Given** The user has navigated away from Release plan in the read/unread sidebar scenario.
- **When** The user marks Release plan unread.
- **Then** Release plan is shown with an Unread indicator.
