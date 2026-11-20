# Sidebar controls

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-controls.test.tsx](sidebar-controls.test.tsx).

## sidebar-controls-001

Original test `Move to the next relevant agent with a shortcut`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L57).

- **Given** The user is viewing Research Agent’s chat, and Support Agent has an unread conversation titled “Support escalation.”
- **When** The user presses Ctrl+Shift+}.
- **Then** The app navigates to Support Agent’s chat and shows “Support escalation” in the sidebar.
- **Upstream change** `4e5707de` (#49556) removes per-agent chat pages and the keyboard shortcuts that moved between agents, and removes this upstream test. Retire this scenario.

## sidebar-controls-002

Original test `Open and use workspace search with the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L99).

- **Given** The sidebar contains a conversation titled “Support escalation.”
- **When** The user presses Ctrl+Shift+F, searches for “support,” then selects the result with Arrow Down and Enter.
- **Then** The workspace search closes and the page title becomes “Support escalation | Okou.”

## sidebar-controls-003

Original test `Pin and unpin agents without closing the pin manager`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L144).

- **Given** The pin manager is open and Research Agent is pinned.
- **When** The user pins Support Agent, then unpins Support Agent.
- **Then** The pin manager stays open throughout; the grid first shows Nova, Research Agent, and Support Agent, then returns to Nova and Research Agent. The app confirms each change.

## sidebar-controls-004

Original test `Keep a pending pin save owned while the manager closes and reopens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L193).

- **Given** A pin save for Research Agent is pending while the pin manager is open.
- **When** The user closes and reopens the manager before the save completes, then waits for it to finish.
- **Then** While the save is pending, Support Agent is disabled in the reopened manager. Once the save completes, Research Agent appears in the grid and Support Agent becomes available to pin.
- **Upstream change** `4e5707de` (#49556) retires pinned agents and the Pin an agent manager and removes this upstream test. Retire this scenario.

## sidebar-controls-005

Original test `Preserve the user’s pinned-agent order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L263).

- **Given** The user’s saved pinned-agent order is Support Agent followed by Research Agent.
- **When** The user opens the app and then opens the pin manager.
- **Then** The pinned grid shows Nova, Support Agent, Research Agent, and the manager lists Support Agent before Research Agent.

## sidebar-controls-006

Original test `Highlight the current thread’s agent in the pinned grid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L291).

- **Given** Research Agent is pinned and the user is viewing its conversation, “Research kickoff.”
- **When** The pinned-agent grid loads.
- **Then** Research Agent is marked as the current page, while Nova is not.

## sidebar-controls-007

Original test `Recognize and pin sidebar conversation states`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L317).

- **Given** The sidebar contains a regular conversation, an unread conversation, a running conversation, and a draft conversation.
- **When** The user inspects their sidebar labels and opens the regular conversation’s menu.
- **Then** The rows are labeled “Release plan,” “Incident notes Unread,” “Running analysis Running,” and “Draft brief Draft.” The state indicators do not replace menu access; the menu trigger remains named “Open chat menu.” The regular conversation can be pinned and unpinned with Ctrl+Shift+D, and the running conversation’s menu offers Rename chat with F2 and Delete chat.

## sidebar-controls-008

Original test `Refresh the agent unread indicator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L426).

- **Given** Nova’s sidebar indicator and a conversation’s indicator both initially have no unread state.
- **When** The server changes the state to unread and an indicator-change notification arrives.
- **Then** Nova’s unread indicator appears.

## sidebar-controls-009

Original test `Refresh the thread unread indicator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L426).

- **Given** Nova’s sidebar indicator and a conversation’s indicator both initially have no unread state.
- **When** The server changes the state to unread and an indicator-change notification arrives.
- **Then** The conversation’s unread indicator appears.
- **Upstream change** `4e5707de` (#49556) retires pinned agents and the Agents page, so only the thread variant remains and it starts on the My Okou chat page at `/`; the upstream test is now `Refresh the thread unread indicator` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L191)). Rebuild this scenario from `/`, observing only the conversation's Unread label.

## sidebar-controls-010

Original test `Refresh the running indicator after the indicator notification without warming chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L489).

- **Given** A conversation is initially marked unread, with no chat content loaded.
- **When** The server changes it to running and sends an indicator notification, then changes it back to unread and sends another notification after the refresh throttle window.
- **Then** The sidebar changes from Unread to Running and back to Unread without warming the chat.
- **Upstream change** `4e5707de` (#49556) retires the Agents page (`/agents` now redirects to My Okou settings at `/?settings=my-okou`), so the upstream test starts on the My Okou chat page at `/`; the upstream test is now `Refresh the running indicator after the %s notification without warming chats` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L239)). Rebuild this scenario from `/`; the Unread, Running, Unread sequence and the no-warming check are unchanged.

## sidebar-controls-011

Original test `Refresh the running indicator after the read cursor notification without warming chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L489).

- **Given** A conversation is initially marked unread, with no chat content loaded.
- **When** The server changes it to running and sends a read-cursor notification, then changes it back to unread and sends another notification after the refresh throttle window.
- **Then** The sidebar changes from Unread to Running and back to Unread without warming the chat.

## sidebar-controls-012

Original test `Refresh the latest unread state after an indicator burst with a failed leading fetch: false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L552).

- **Given** A conversation is initially not unread, and an indicator refresh request is in flight when the server changes its state.
- **When** The server changes it to unread and sends 20 more indicator notifications; the leading refresh fails with a 503 response.
- **Then** After the notification burst, the sidebar shows the latest unread state.
- **Upstream change** `4e5707de` (#49556) retires the Agents page (`/agents` now redirects to My Okou settings at `/?settings=my-okou`), so the upstream test starts on the My Okou chat page at `/`; the upstream test is now `Refresh the latest unread state after an indicator burst with a failed leading fetch: %s` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L302)). Rebuild this scenario from `/`; the burst and final unread state are unchanged.

## sidebar-controls-013

Original test `Refresh the latest unread state after an indicator burst with a failed leading fetch: true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L552).

- **Given** A conversation is initially not unread, and an indicator refresh request is in flight when the server changes its state.
- **When** The server changes it to unread and sends 20 more indicator notifications; the leading refresh succeeds.
- **Then** After the notification burst, the sidebar shows the latest unread state.

## sidebar-controls-014

Original test `Open a conversation with double-click and rename it from the sidebar menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L615).

- **Given** The sidebar lists “Release plan” and “Incident notes,” with “Incident notes” open.
- **When** The user double-clicks “Release plan,” renames it to “Launch plan,” opens “Incident notes,” then reopens the renamed conversation’s menu and renames it to “Final launch plan.”
- **Then** “Release plan” becomes the active conversation, then its sidebar title changes to “Launch plan” and later “Final launch plan.” After the second rename, “Incident notes” remains the active conversation.

## sidebar-controls-015

Original test `Reorder pinned agents while keeping Nova first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L682).

- **Given** Six pinned agents appear in this order: Nova, Research Agent, Support Agent, Operations Agent, Analytics Agent, Billing Agent.
- **When** The user drags Support Agent onto Billing Agent, then tries to drag Research Agent onto Nova.
- **Then** Support Agent moves to the end, after Billing Agent, while Nova remains first. The attempted drop onto Nova is rejected and the order stays unchanged.
- **Upstream change** `4e5707de` (#49556) retires pinned agents and the pinned-agent grid and removes this upstream test. Retire this scenario.

## sidebar-controls-016

Original test `Keep the default Okou sweater outside a circular mask`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L755). · **intent review**

- **Given** The default Okou avatar is displayed in the pinned-agent grid.
- **When** The avatar is rendered with the app’s Tailwind utilities.
- **Then** The image has no computed border radius, so it is not circularly masked.

## sidebar-controls-017

Original test `Search, pin, and open an agent from the pin manager`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-controls.test.tsx#L772).

- **Given** The pin manager lists Research Agent and Support Agent, and a Research Agent conversation titled “Research kickoff” exists.
- **When** The user searches for “support,” searches for “ops,” clears the search, pins Research Agent, closes the manager, and opens Research Agent from the grid.
- **Then** The first search shows Support Agent but not Research Agent; “ops” shows no results. Clearing search restores Research Agent. After pinning, the manager offers Unpin, and opening the agent shows “Chats with Research Agent” and “Research kickoff” in the sidebar.
- **Upstream change** `4e5707de` (#49556) retires pinned agents, the Pin an agent manager, and per-agent chat pages, and removes this upstream test. Retire this scenario.
