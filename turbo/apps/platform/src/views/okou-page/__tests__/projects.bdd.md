# Projects

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [projects.test.tsx](projects.test.tsx).

## projects-001

Original test `My Okou's Project rows expose title folding and a home link before their menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L234).

- **Given** A user is viewing an ordinary chat in My Okou, where the Launch Project appears.
- **When** The Project row is displayed.
- **Then** Its title has a control to fold or unfold chats, and its + home link points to /projects/{project ID} and appears before the Options control.

## projects-002

Original test `Cached Projects appear before chat setup and remote synchronization finish`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L265).

- **Given** A cached Launch Project and its chat are available, while chat setup and remote Project synchronization are still pending.
- **When** The page loads from the cached data and remote synchronization later reports the name Launch updated.
- **Then** The Project and chat appear before either pending operation finishes, and the Project updates to Launch updated while chat setup remains pending.

## projects-003

Original test `Projects stay visible when returning from a chat to My Okou during a refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L335).

- **Given** A user has expanded Launch and can see its planning chat while viewing another chat.
- **When** A Project refresh starts and the user returns to My Okou before it completes.
- **Then** The Project and its planning chat stay visible during the refresh and after Launch is renamed to Launch updated; the Project row never disappears.

## projects-004

Original test `Projects are cleared when the authenticated account changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L418).

- **Given** An authenticated user sees the Launch Project.
- **When** The authenticated account changes to another user.
- **Then** Launch is no longer shown.

## projects-005

Original test `Projects are cleared when the authenticated workspace changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L418).

- **Given** An authenticated user sees the Launch Project.
- **When** The authenticated workspace changes to another workspace.
- **Then** Launch is no longer shown.

## projects-006

Original test `Projects remember open and collapsed states after a page reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L456).

- **Given** Launch starts expanded and Research starts collapsed, with chats assigned to each Project.
- **When** The user folds Launch, unfolds Research, and reloads the page.
- **Then** Launch remains folded with its chat hidden, while Research remains unfolded with its chat visible.

## projects-007

Original test `Project expansion preferences stay separate for each account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L503).

- **Given** A user has saved an expanded state for Launch under one account.
- **When** The user reloads with a different authenticated account.
- **Then** Launch has a separate, initially collapsed expansion preference; the user can expand it.

## projects-008

Original test `Project expansion preferences stay separate for each workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L503).

- **Given** A user has saved an expanded state for Launch in one workspace.
- **When** The user reloads in a different authenticated workspace.
- **Then** Launch has a separate, initially collapsed expansion preference; the user can expand it.

## projects-009

Original test `Projects remain usable with invalid cached preferences: not json`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L548).

- **Given** The cached Project expansion preference is the invalid value "not json".
- **When** The user opens the page and folds and unfolds Launch.
- **Then** Launch starts collapsed and can be expanded and collapsed normally.

## projects-010

Original test `Projects remain usable with invalid cached preferences: {"invalid":"true"}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L548).

- **Given** The cached Project expansion preference is the invalid JSON object {"invalid":"true"}.
- **When** The user opens the page and folds and unfolds Launch.
- **Then** Launch starts collapsed and can be expanded and collapsed normally.

## projects-011

Original test `Projects show cross-Agent chats inline and follow the list filter without leaving the current conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L579).

- **Given** The user is viewing an ordinary chat, and Launch contains chats from multiple Agents, including an archived chat.
- **When** The user expands Launch, then switches the chat-list filter to Archived and folds Launch.
- **Then** The expanded Project shows its non-archived chats from both Agents but not the ordinary or archived chat; the Archived filter shows the archived chat instead. The current conversation does not change when the Project is expanded or folded.

## projects-012

Original test `Chat navigation shortcuts move through expanded Projects and the chats outside them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L670).

- **Given** A Project is expanded, and the user is viewing the first chat outside it with the message composer focused.
- **When** The user presses ArrowUp and then ArrowDown for chat navigation.
- **Then** ArrowUp selects the last chat in the expanded Project, and ArrowDown returns to the chat outside the Project.

## projects-013

Original test `A folded Project keeps the open chat's place: up selects the Project and down passes the fold`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L689).

- **Given** The user is viewing a chat in Launch after folding the Project, with the message composer focused.
- **When** The user presses ArrowDown and then ArrowUp for chat navigation.
- **Then** ArrowDown moves to the next chat outside the folded Project. ArrowUp selects the Launch Project page, which remains folded.

## projects-014

Original test `Project titles only fold chats, while the + link opens and selects their home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L716).

- **Given** The user is viewing a chat outside Launch, whose chats are initially folded.
- **When** The user clicks the Project title, clicks it again, then opens the + home link and expands the Project.
- **Then** The title only folds or unfolds the chats without changing the current chat. The + link opens and selects the Project home; expanding there shows its chats, and browser Back returns to the prior chat with the Project still expanded.

## projects-015

Original test `Project titles support Enter and Space, with Tab reaching the + home link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L753).

- **Given** The user is viewing a chat in Launch, with the Project title and + home link available.
- **When** The user focuses the title, presses Enter and Space, tabs to the + link, and presses Enter.
- **Then** Enter folds and Space unfolds the Project without leaving the chat. Tab focuses the home link, which opens the Project home while preserving the expanded state.

## projects-016

Original test `The Project title disclosure exposes the shortcut for its current fold state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L775).

- **Given** Launch is initially folded.
- **When** The user expands it.
- **Then** The disclosure advertises the collapse shortcut while folded and the expand shortcut while expanded; its advertised shortcut changes with the state.

## projects-017

Original test `A Project name's emoji sits on its folder, and the name shows the rest`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L792).

- **Given** The Project is named ☕ Coffee.
- **When** The Project row is displayed.
- **Then** The folder control shows the coffee emoji, the Project name displays Coffee, and the Project home link is available.

## projects-018

Original test `The + home link preserves modified clicks without changing the current page or fold`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L806).

- **Given** The user is viewing a chat while Launch is folded.
- **When** The user Ctrl-clicks and Meta-clicks the Project home link.
- **Then** The current page and the Project's folded state remain unchanged, and its chats stay hidden.

## projects-019

Original test `A folded Project prioritizes unread over running chats, and an unfolded one leaves each state to its chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L842).

- **Given** Research contains unread chats on both sides of a running chat; Launch contains an unread chat; Build contains a running chat; Quiet contains only a quiet chat in the current list, although an archived chat there is running.
- **When** The Project rows are viewed folded, Research is expanded and folded again, and the list filter changes to Unread.
- **Then** Folded Projects prioritize Unread over Running, while Build reports Running and Quiet has no state indicator because its running chat is archived and excluded. Expanded Research leaves unread and running indicators to its individual chats; folding it restores the Project's Unread indicator. The Unread filter hides Build and continues to report Research and Launch as unread.

## projects-020

Original test `A Project page moves down into its chats when unfolded and past them when folded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L967).

- **Given** The user is on the folded Launch Project page.
- **When** The user navigates down, back up, expands Launch, focuses the composer, and navigates down again.
- **Then** From the folded Project page, ArrowDown goes past its chats to the next chat and ArrowUp returns to the Project page. Once expanded, ArrowDown enters the first Project chat.

## projects-021

Original test `Project fold shortcuts fold and unfold the open chat's Project unless the composer holds text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L998).

- **Given** The user is viewing a chat in expanded Launch with an empty composer.
- **When** The user uses the Project fold shortcuts to fold and unfold it, then types Draft and presses the fold shortcut again.
- **Then** The shortcuts fold and unfold Launch without changing the open chat. With Draft in the composer, the shortcut does not fold the Project or alter the text.

## projects-022

Original test `A Project page folds its own Project, and a chat outside Projects folds none`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1022).

- **Given** The user is first on the Launch Project page, then navigates to a chat outside any Project.
- **When** The user uses the fold shortcuts on each page and opens the keyboard-shortcuts dialog while on the Project page.
- **Then** The shortcuts fold and unfold Launch on its own page, and the dialog names both Collapse Project and Expand Project. On the outside chat, the expand shortcut does not expand Launch.

## projects-023

Original test `A Project's menu folds it with the shortcut shown, and the keys act on the menu's Project`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1055).

- **Given** Launch is expanded, and the user opens the menu for Launch and then the menu for folded Campaign.
- **When** The user chooses Collapse for Launch, then uses the expand shortcut while Campaign's menu is open.
- **Then** The menu shows the collapse shortcut and folds Launch. The open Campaign menu directs the shortcut to Campaign, expanding it while Launch remains folded.

## projects-024

Original test `ordinary lists hide assigned chats and @Project inserts captured identity without navigating`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1091).

- **Given** An ordinary chat and a Launch-assigned chat are available, and the user is composing in the ordinary chat.
- **When** The user enters @Launch and selects the Project suggestion.
- **Then** Ordinary chat lists omit the assigned chat. The composer receives a Launch mention tied to that Project, and the user stays in the ordinary conversation.

## projects-025

Original test `creates, renames and deletes a Project through the shared dialogs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1134).

- **Given** The user is viewing an ordinary chat with no additional Project created.
- **When** The user creates Campaign, renames it Campaign two, then deletes it through the Project dialogs.
- **Then** Campaign appears expanded before creation confirmation arrives; the dialog closes without navigating away from the chat. The renamed Project appears, and after deletion Campaign two disappears and focus returns to Create Project.

## projects-026

Original test `Deleting a Project closes its dialog before its chats finish synchronizing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1258).

- **Given** Launch has an assigned chat, and the user is viewing another chat.
- **When** The user confirms deletion of Launch while synchronization of its chat membership is still pending.
- **Then** The deletion dialog closes and Launch disappears before chat synchronization finishes. After synchronization, the formerly assigned chat is available outside the Project, and the current conversation and Create Project focus are preserved.

## projects-027

Original test `A rejected Project deletion stays open and can be retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1359).

- **Given** The user has opened the deletion dialog for Launch, and the first deletion attempt will be rejected.
- **When** The user confirms deletion, then retries after the rejection.
- **Then** While the request is pending, the delete button is disabled and Launch remains. The rejected attempt shows an error, leaves the dialog open, and re-enables the button. A successful retry closes the dialog, removes Launch, and returns focus to Create Project without navigating away.

## projects-028

Original test `Creating a Project from a chat moves it immediately and survives navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1431).

- **Given** The user is viewing Campaign planning and another conversation.
- **When** The user creates a Project named Campaign from the current chat's menu, navigates to the other conversation while creation is pending, and then confirms creation.
- **Then** The current chat moves into an expanded Campaign immediately, before confirmation, and remains grouped there after navigating away and receiving the confirmed name Campaign confirmed. The chat appears once in the Project.

## projects-029

Original test `A new Project's home accepts a message once its pending creation is confirmed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1567).

- **Given** The user creates Campaign and opens its home while Project creation is pending.
- **When** The user types a message and waits for creation confirmation before sending it.
- **Then** Send remains disabled until the Project is confirmed. Once enabled, sending creates a chat in that Project and navigates to the new chat.

## projects-030

Original test `Thread menu searches and changes Project membership while preserving the open chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1688).

- **Given** The user is viewing an ordinary chat and Launch and Research Projects are available.
- **When** The user opens the Move to Project dialog, searches for a missing name and then for "laun", moves the chat to Launch, moves it to Research, and removes it from the Project.
- **Then** The missing search reports no results, and the partial search finds Launch. Each membership change updates the Project listing while preserving the open chat. Removing the chat leaves it available in the ordinary list.

## projects-031

Original test `A rejected Project move does not replace a later confirmed move`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1804).

- **Given** The user is viewing an ordinary chat and both Launch and Research are available; the first membership change request will be rejected.
- **When** The user moves the chat to Launch, then makes a later move to Research.
- **Then** The rejected move shows the conflict message and does not replace the later confirmed move. After the later move, both the ordinary chat and a separate Reference notes chat appear in Research.

## projects-032

Original test `Dropping over an existing Project chat moves immediately while the request is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1892).

- **Given** The user is viewing an ordinary chat and Launch contains a different chat; the ordinary chat is dragged onto the existing Project chat while the move request is pending.
- **When** The user drops the dragged chat onto the Launch chat.
- **Then** The drop indicates Move to Launch, and the chat appears under Launch immediately while the request is pending. The open conversation is unchanged, the drop indicator disappears, and the chat remains in Launch after synchronization.

## projects-033

Original test `Dropping a Project chat onto the outer chat row removes it while preserving the open chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1974).

- **Given** The user is viewing a chat assigned to Launch, and an ordinary chat is available as the drop destination.
- **When** The user drags the Project chat onto the ordinary chat row while removal is pending.
- **Then** The drop indicates Remove from Project, and the chat leaves Launch immediately. The open conversation stays unchanged, and the chat remains outside the Project after synchronization.

## projects-034

Original test `Dropping a Project chat onto the outer empty list space removes it while preserving the open chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L1974).

- **Given** The user is viewing the only chat assigned to Launch, with empty space in the outer chat list available as a drop destination.
- **When** The user drags the Project chat onto the empty list space while removal is pending.
- **Then** The drop indicates Remove from Project, and the chat leaves Launch immediately. The open conversation stays unchanged, and the chat remains outside the Project after synchronization.

## projects-035

Original test `A cross-Agent Project chat can be dragged onto another collapsed Project`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2052).

- **Given** The user is viewing an ordinary chat; Launch is expanded and contains a chat from another Agent, while Research is folded.
- **When** The user drags the cross-Agent chat onto Research.
- **Then** The drop indicates Move to Research. The chat appears under Research, which expands, and disappears from Launch; the current conversation remains open.

## projects-036

Original test `Escape cancels a Project drag, and unrelated drags or the current Project are not accepted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2104).

- **Given** An ordinary chat and a chat already in Launch are listed, and the ordinary chat is open.
- **When** The user drags the ordinary chat over Launch, presses Escape, then drops it; they also try dragging the Launch chat and an external URL over Launch.
- **Then** Escape removes the drop hint and cancels the ordinary chat move. The ordinary chat stays outside Launch; dragging the current Launch chat or external content does not change membership or the open chat.

## projects-037

Original test `A failed drag move shows an error beside its destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2157).

- **Given** An ordinary chat is open and moving it into Launch will be rejected with a permission error.
- **When** The user drags the chat onto Launch.
- **Then** An error reading “Could not move chat” appears, the drop hint disappears, and the ordinary chat remains open.

## projects-038

Original test `Project deep links open the Project page with its composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2186).

- **Given** Launch exists and the user opens its direct URL.
- **When** The Project page loads.
- **Then** The page shows the greeting, a message composer labeled Message with the Launch chip, and marks the Launch home link as current at the Project URL.

## projects-039

Original test `A Project page shares the capability home and its compliance block under the cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2214).

- **Given** The user opens the Launch Project page.
- **When** The capability home content loads.
- **Then** The greeting, Explore Okou capabilities cards, compliance block, and message composer are shown. The compliance block follows the cards and precedes the editor, outside the composer.

## projects-040

Original test `Home, Project, and conversation navigation preserves the correct draft and send destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2252).

- **Given** Home has the saved draft “New conversation draft,” while an existing conversation has the separate draft “Conversation-only draft.”
- **When** The user navigates from Home to Launch, opens the existing conversation, returns to a new chat, revisits Launch, and sends a new message.
- **Then** Home and Launch show the same new-conversation draft; the existing conversation shows its own draft. A new chat has no Project chip, and sending from Launch creates and opens a conversation belonging to Launch.

## projects-041

Original test `A mobile Project opens the capability composer instead of the home chat list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2321).

- **Given** The user is on a mobile device and opens Launch.
- **When** The Project page loads and they enter a message.
- **Then** The page shows the capability composer and Launch chip rather than the home chat list, and Send becomes enabled.

## projects-042

Original test `A Project message keeps its membership in the conversation it opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2347).

- **Given** Launch is open and the default Agent is known from an existing conversation.
- **When** The user writes “Plan the launch” and sends it from the Project page.
- **Then** A conversation is created for the default Agent in Launch, the app navigates to that conversation, and it appears as the current chat within Launch.

## projects-043

Original test `The composer's + menu starts a new chat in a Project and keeps the message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2418).

- **Given** The user is on Home with the message “Plan the launch,” and Launch and Campaign exist.
- **When** They choose Launch from the composer’s add menu, switch to Campaign through that menu, and send the message.
- **Then** The Project choices appear in the menu, with Launch disabled while it is current. The message is preserved across both Project changes, and sending creates a conversation in Campaign.

## projects-044

Original test `Removing the Project chip returns the message to a chat outside any Project`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2496).

- **Given** Launch is open with the unsent message “Outside the launch.”
- **When** The user removes the Launch chip and sends the message.
- **Then** The app returns to Home without losing the message; the chip is absent and the resulting conversation has no Project membership.

## projects-045

Original test `The composer shows a Project name's emoji on its folder, as the sidebar does`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2540).

- **Given** A Project named “☕ Coffee” is open.
- **When** The user views its composer chip and the Project choices in the add menu.
- **Then** Both show the coffee emoji on the folder and “Coffee” as the name; the current Project is disabled in the menu.

## projects-046

Original test `A Project named from the composer's + menu opens with the message and accepts it once created`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2575).

- **Given** The user is on Home with “Kick off the campaign” entered, and creation of a new Project is awaiting confirmation.
- **When** They create a Project named Campaign from the add menu and try to send before confirmation, then send after confirmation.
- **Then** The Campaign page opens immediately with the message preserved, but Send remains disabled until Project creation is confirmed. After confirmation Send becomes enabled and creates a conversation in Campaign.

## projects-047

Original test `Without Projects the new chat's add menu keeps capabilities available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2689).

- **Given** The user is starting a new chat with Projects unavailable.
- **When** They open the composer’s add menu.
- **Then** The menu still offers Attach, Template, Find people, Research, Create, Workflow, and Import skills; it does not offer Project.

## projects-048

Original test `The Project home starts a conversation with the default Agent after visiting another Agent's chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2716).

- **Given** The user has visited a Project chat belonging to another Agent, then returns to the Launch home page.
- **When** They start a new conversation from Launch and send “Start Project research.”
- **Then** The new conversation uses the workspace’s default Agent, not the other Agent, and belongs to Launch. It opens immediately and appears exactly once in Launch after the persisted chat-list event arrives.

## projects-049

Original test `Project rename closes immediately and yields to persisted events`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2850).

- **Given** Launch exists and its rename request has not yet been confirmed by the server.
- **When** The user saves the name “Launch renamed,” then the server sends persisted rename events naming it “Launch confirmed.”
- **Then** The rename dialog closes immediately, the optimistic name appears, and focus returns to its options control before confirmation. The persisted name later replaces it.

## projects-050

Original test `A rejected Project name does not replace the confirmed name of a later save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L2926).

- **Given** Launch exists, and the first rename request will be rejected with a conflict.
- **When** The user saves “Launch draft,” then opens rename again and saves “Launch plan”; persisted events report “Launch confirmed.”
- **Then** The conflict message is shown, and the rejected draft remains visible until the next save. The later persisted name becomes “Launch confirmed.”

## projects-051

Original test `Project membership join updates before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3034).

- **Given** Planning chat has no Project membership; the user is on desktop and Launch exists.
- **When** They choose Move to Project and select Launch while the membership request is awaiting confirmation.
- **Then** Planning chat immediately appears under Launch, the move dialog closes, and the current URL stays on the chat. When persisted events arrive, the chat remains in Launch.

## projects-052

Original test `Project membership move updates before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3034).

- **Given** Planning chat belongs to Launch; the user is on desktop and Research exists.
- **When** They choose Move to Project and select Research while the membership request is awaiting confirmation.
- **Then** The chat immediately appears under Research, the move dialog closes, and the current URL stays on the chat. When persisted events arrive, it appears outside Launch rather than remaining in its old Project.

## projects-053

Original test `Project membership leave updates before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3034).

- **Given** Planning chat belongs to Launch; the user is on desktop.
- **When** They choose Move to Project and select Remove from Project while the membership request is awaiting confirmation.
- **Then** The chat immediately appears outside any Project, the move dialog closes, and the current URL stays on the chat. When persisted events arrive, it remains outside Launch.

## projects-054

Original test `Project membership join on PWA updates before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3034).

- **Given** Planning chat has no Project membership; the user is on a PWA and Launch exists.
- **When** They choose Move to Project and select Launch while the membership request is awaiting confirmation.
- **Then** Planning chat immediately appears under Launch, the move dialog closes, and the current URL stays at Home. When persisted events arrive, the chat remains in Launch.

## projects-055

Original test `Deleting another Agent's Project chat removes it before confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3142).

- **Given** The current chat is open, and another Agent’s Project chat is listed under Launch.
- **When** The user deletes the other Agent’s chat and the deletion request is awaiting confirmation.
- **Then** The deleted chat disappears and Launch shows “No chats here yet” before confirmation; the current chat remains open.

## projects-056

Original test `PWA uses the same Projects and a bottom sheet for Thread membership`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3189).

- **Given** The user is on a PWA at Home with ordinary and Launch chats listed.
- **When** They open Launch, open the member chat’s menu, choose Move to Project, dismiss the chooser, then open that member chat.
- **Then** The same Projects are available, and the move chooser is a bottom sheet with a project search field. Dismissing it leaves the chat available to open, and its conversation page shows the message composer.

## projects-057

Original test `A Project mention reveals a folded chat sidebar and keeps the current conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L3249).

- **Given** The current conversation contains a Launch mention, the chat list is hidden, and Launch contains another chat.
- **When** The user clicks the Launch mention.
- **Then** The chat list is revealed with Launch expanded and its member chat visible, while the current conversation remains open.
