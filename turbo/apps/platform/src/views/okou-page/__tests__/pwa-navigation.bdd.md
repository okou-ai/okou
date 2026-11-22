# Pwa navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [pwa-navigation.test.tsx](pwa-navigation.test.tsx).

## pwa-navigation-001

Original test `Keep the desktop navigation in a desktop PWA`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L67).

- **Given** A user opens the chat list in a desktop PWA with an existing conversation.
- **When** The page loads at the chat-list address.
- **Then** The message composer and desktop navigation rail are visible, and the address remains the chat-list path.

## pwa-navigation-002

Original test `Switch between the desktop composer and mobile chat list as the browser resizes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L87).

- **Given** A user opens the chat list on a desktop with an existing conversation.
- **When** The browser narrows below the desktop breakpoint and then widens again.
- **Then** The narrow view shows the mobile main navigation and conversation list; the wide view restores the composer and desktop navigation rail. The chat-list address remains unchanged.

## pwa-navigation-003

Original test `Open workspace search from the compact mobile chat header (standalone: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L125).

- **Given** A user is viewing the mobile chat list in a regular browser with a conversation present.
- **When** The user opens workspace search from the compact header and presses Escape.
- **Then** The header offers agent switching, workspace search, new chat, and the chat-list menu in that order. Search opens with its field focused, then closes; the conversation list and chat-list address remain visible.
- **Upstream change** `4e5707de` (#49556) removes the mobile agent switcher (the compact header now shows the assistant name), always shows Create Project, and serves the mobile chat list at `/`; the upstream test is now `Open workspace search from the compact mobile chat header (standalone: %s)` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L124)). Rebuild this scenario at `/`, expecting the header buttons Search workspace, Create Project, New chat, and Open chat list menu in that order.

## pwa-navigation-004

Original test `Open workspace search from the compact mobile chat header (standalone: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L125).

- **Given** A user is viewing the mobile chat list in a standalone PWA with a conversation present.
- **When** The user opens workspace search from the compact header and presses Escape.
- **Then** The header offers agent switching, workspace search, new chat, and the chat-list menu in that order. Search opens with its field focused, then closes; the conversation list and chat-list address remain visible.

## pwa-navigation-005

Original test `Keep Me within mobile widths while the browser resizes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L177).

- **Given** A user opens Me at a mobile viewport.
- **When** The browser widens to the desktop breakpoint and then narrows again.
- **Then** The wide view shows the not-found page, while the narrow view restores Me and mobile main navigation; the address remains /me.

## pwa-navigation-006

Original test `Browse and filter mobile browser chats before opening a conversation and returning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L211).

- **Given** A user views the mobile chat list in a regular browser with one active conversation and one archived conversation.
- **When** The user opens the chat-list menu, selects Archived, opens the archived conversation, returns to chats, starts a new chat, and opens Me.
- **Then** The initial list shows the active conversation but not the archived one, and its navigation marks Chats current alongside Connectors, Artifacts, and Me. Archived filtering shows only the archived conversation without changing the chat-list address. Opening it shows the composer at its conversation address; returning restores the list and agent name. New chat shows the composer at the chat-list address with compose=1 and a Back to chats control. Me then opens at /me.
- **Upstream change** `4e5707de` (#49556) moves the mobile chat list to `/` and replaces the agent switcher with the assistant name, so returning no longer checks an agent name; the upstream test is now `Browse and filter mobile browser chats before opening a conversation and returning` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L210)). Rebuild this scenario with `/` as the chat-list address (Chats tab, Back to chats, and New chat at `/?compose=1`) and drop the agent-name check.

## pwa-navigation-007

Original test `Slide conversations in from the mobile chat list and out back to the tabs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L307).

- **Given** A user views a mobile standalone PWA chat list with one conversation.
- **When** The user opens the conversation, returns with Back to chats, opens it again, returns using browser history, and then opens Me.
- **Then** Opening the conversation and returning use push then pop transitions; repeating the sequence does the same. Browser history returns to the list with a pop transition. Opening Me changes page without adding a transition.

## pwa-navigation-008

Original test `My Okou's chats tab is its chat list at / and composes a new chat there`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L384).

- **Given** A user with the single-agent feature enabled opens the root address in a mobile standalone PWA with an existing conversation.
- **When** The user opens the conversation, returns to the list, and starts a new chat.
- **Then** The Chats tab at / is current and shows the conversation. Opening and returning use push and pop transitions. New chat shows the composer at /?compose=1 with Back to chats linking to /, and uses a push transition.

## pwa-navigation-009

Original test `Leave the slide to the browser after an edge swipe back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L443).

- **Given** A user views a mobile browser chat list with one conversation.
- **When** The user opens the conversation and performs an edge swipe back.
- **Then** The conversation closes and the chat list returns at its original address. Only the initial navigation into the conversation starts a view transition.

## pwa-navigation-010

Original test `Change desktop pages without a slide`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L484).

- **Given** A user views the desktop PWA composer for a conversation.
- **When** The user opens that conversation from the page.
- **Then** The address changes to the conversation path without starting a view transition.

## pwa-navigation-011

Original test `Open profile settings from Me in a regular mobile browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L515).

- **Given** A user opens Me in a regular mobile browser and is signed in as Chat list user.
- **When** The user opens Settings.
- **Then** A Settings dialog appears containing Account & security and the signed-in user's name.

## pwa-navigation-012

Original test `Start the first chat from an empty mobile chat list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L542).

- **Given** A user views an empty chat list in a mobile standalone PWA.
- **When** The user selects New chat in the empty-state message.
- **Then** The composer appears at the chat-list address with compose=1.

## pwa-navigation-013

Original test `Step back to Me from the pages it opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L568).

- **Given** A user opens Me in a mobile standalone PWA.
- **When** The user opens Workflows and then uses Back.
- **Then** Workflows opens and the navigation still marks Me as current. Back returns to Me at /me.

## pwa-navigation-014

Original test `Point to unread chats in other agents from the tabs and the agent switcher`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L601).

- **Given** A user views a mobile browser chat list, and another agent has unread chats while the current agent does not.
- **When** The user checks the navigation and opens the agent switcher.
- **Then** Unread indicators appear on the Chats tab and the other agent's switcher option, but not on Me or the current agent's option.
- **Upstream change** `4e5707de` (#49556) removes the mobile agent switcher, so the Chats tab at `/` alone points to unread chats from any agent; the upstream test is now `Show the Chats tab unread indicator across all Chats` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L596)). Rebuild this scenario at `/`: when only another agent has unread chats, the Chats tab shows Unread and Me does not; drop the switcher-option checks.
- **Batch 75 main synchronization** [Member-flow change #49854](https://github.com/okou-ai/okou/pull/49854). The member thread snapshot has no agent ownership. The unread conversation still marks Chats and leaves Me clear. Its ownership by a different agent cannot be constructed, including under the batch 69 amendment.

## pwa-navigation-015

Original test `Keep a PWA home prompt handoff in the prepared chat composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L678).

- **Given** A user opens the root address in a mobile standalone PWA with a prompt query requesting “Draft a launch plan.”
- **When** The page prepares the chat composer.
- **Then** The composer contains “Draft a launch plan,” the address is the chat-list path, and mobile main navigation is visible.

## pwa-navigation-016

Original test `Remove a disconnected subscription from Me without reopening the page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L704).

- **Given** A user opens Me in a mobile standalone PWA with a connected ChatGPT subscription.
- **When** The user opens Settings, visits Models, disconnects the listed account, confirms, and closes Settings.
- **Then** An account-disconnected confirmation appears and the confirmation dialog closes. Closing Settings returns to Me without reopening the page; the ChatGPT heading is gone and the address remains /me.

## pwa-navigation-017

Original test `Switch the mobile browser chat list to another agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/pwa-navigation.test.tsx#L789).

- **Given** A user views the mobile browser chat list for List agent, with one conversation for that agent and another for Research agent.
- **When** The user opens the agent switcher and selects Research agent.
- **Then** Initially only the List agent conversation is shown. After switching, the Research agent conversation appears, the switcher names Research agent, the address changes to that agent's chat-list path, the List agent conversation is absent, and the Chats tab for the new path is current.
- **Upstream change** `4e5707de` (#49556) retires the mobile agent switcher and per-agent chat lists (`/agents/{id}/chat` now redirects to `/`) and removes this upstream test. Retire this scenario.
