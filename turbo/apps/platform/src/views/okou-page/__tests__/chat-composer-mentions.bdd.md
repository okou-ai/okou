# Chat composer mentions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-mentions.test.tsx](chat-composer-mentions.test.tsx).

## chat-composer-mentions-001

Original test `Show matching chat threads in priority order from the top (new chat: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L173).

- **Given** A user is composing in an existing chat with matching threads titled “Project Beta follow-up” and “Project Beta.”
- **When** They type “@beta” and navigate the suggestions with the arrow keys and Enter.
- **Then** The suggestions appear in that order, with “Project Beta follow-up” selected initially. ArrowUp keeps the first suggestion selected; ArrowDown selects “Project Beta”; ArrowUp followed by Enter inserts “Project Beta follow-up,” closes the menu, and leaves focus in the composer.

## chat-composer-mentions-002

Original test `Show matching chat threads in priority order from the top (new chat: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L173).

- **Given** A user is composing a new chat with matching threads titled “Project Beta follow-up” and “Project Beta.”
- **When** They type “@beta” and navigate the suggestions with the arrow keys and Enter.
- **Then** The suggestions appear in that order, with “Project Beta follow-up” selected initially. ArrowUp keeps the first suggestion selected; ArrowDown selects “Project Beta”; ArrowUp followed by Enter inserts “Project Beta follow-up,” closes the menu, and leaves focus in the composer.

## chat-composer-mentions-003

Original test `Keep archived chats in @ mention suggestions when archiving is enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L209).

- **Given** A user is in a chat with an archived thread titled “Archived mention context”; archived threads are absent from the ordinary chat list.
- **When** They type “@archived” in the composer.
- **Then** “Archived mention context” appears in the mention suggestions.

## chat-composer-mentions-004

Original test `Show the @ search hint until typing, selection or dismissal (new chat: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L300).

- **Given** A user is composing in an existing chat and types “Draft @”.
- **When** They begin and end an IME composition, type “zeta” and confirm the agent suggestion, then type “Draft @” again and press Escape.
- **Then** The search hint is visible after typing “Draft @”, disappears during composition, and returns when composition ends. Enter during composition does not insert an agent mention and leaves the suggestion menu open. Typing “zeta” hides the hint; confirming inserts “Zeta Agent” and keeps the hint hidden. Escape closes the menu and hides the hint while preserving “Draft @” and composer focus.

## chat-composer-mentions-005

Original test `Show the @ search hint until typing, selection or dismissal (new chat: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L300).

- **Given** A user is composing a new chat and types “Draft @”.
- **When** They begin and end an IME composition, type “zeta” and confirm the agent suggestion, then type “Draft @” again and press Escape.
- **Then** The search hint is visible after typing “Draft @”, disappears during composition, and returns when composition ends. Enter during composition does not insert an agent mention and leaves the suggestion menu open. Typing “zeta” hides the hint; confirming inserts “Zeta Agent” and keeps the hint hidden. Escape closes the menu and hides the hint while preserving “Draft @” and composer focus.

## chat-composer-mentions-006

Original test `Show the @ hint before adjacent text and preserve it when inserting a mention (new chat: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L358).

- **Given** A user is composing in an existing chat with the text “1231” and the cursor positioned before it.
- **When** They type “@zeta” and confirm the “Zeta Agent” suggestion.
- **Then** The search hint appears before “1231” after typing @, and the composer text reads “@1231”. Typing “zeta” hides the hint; confirming inserts “Zeta Agent” before “1231” and leaves the hint hidden.

## chat-composer-mentions-007

Original test `Show the @ hint before adjacent text and preserve it when inserting a mention (new chat: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L358).

- **Given** A user is composing a new chat with the text “1231” and the cursor positioned before it.
- **When** They type “@zeta” and confirm the “Zeta Agent” suggestion.
- **Then** The search hint appears before “1231” after typing @, and the composer text reads “@1231”. Typing “zeta” hides the hint; confirming inserts “Zeta Agent” before “1231” and leaves the hint hidden.

## chat-composer-mentions-008

Original test `Composer-anchored mentions keep priority order and select the top candidate by default (new chat: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L399).

- **Given** A user is composing in an existing chat where the matching agents are Reviewer, Private Ops, and Zeta Agent, and a matching chat thread is titled “Zeta launch notes.”
- **When** They type @ and navigate the suggestions with the arrow keys and Enter.
- **Then** Agents appear before chat threads, with Reviewer, Private Ops, and Zeta Agent first in that order; Reviewer is selected initially and Scout is not suggested. “Zeta launch notes” appears among the thread suggestions. ArrowUp keeps Reviewer selected, ArrowDown selects Private Ops, and ArrowUp followed by Enter inserts Reviewer and closes the menu while retaining composer focus.

## chat-composer-mentions-009

Original test `Composer-anchored mentions keep priority order and select the top candidate by default (new chat: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L399).

- **Given** A user is composing a new chat where the matching agents are Reviewer, Private Ops, and Zeta Agent, and a matching chat thread is titled “Zeta launch notes.”
- **When** They type @ and navigate the suggestions with the arrow keys and Enter.
- **Then** Agents appear before chat threads, with Reviewer, Private Ops, and Zeta Agent first in that order; Reviewer is selected initially and Scout is not suggested. “Zeta launch notes” appears among the thread suggestions. ArrowUp keeps Reviewer selected, ArrowDown selects Private Ops, and ArrowUp followed by Enter inserts Reviewer and closes the menu while retaining composer focus.

## chat-composer-mentions-010

Original test `Composer-anchored mentions open above the centred start page composer too`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L438).

- **Given** A user is composing a new chat on the centred start page in a wide window, with matching agents Reviewer, Private Ops, and Zeta Agent.
- **When** They type @ and navigate the suggestions with the arrow keys.
- **Then** The mention menu opens above the composer and lists Reviewer, Private Ops, and Zeta Agent first, with Reviewer selected initially. ArrowUp keeps Reviewer selected and ArrowDown selects Private Ops.

## chat-composer-mentions-011

Original test `Composer-anchored mentions navigate downward across groups and insert the visual target`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L463).

- **Given** A user is composing in an existing chat; agent suggestions are listed before matching chat threads.
- **When** They type @, press ArrowDown three times, and press Tab.
- **Then** The thread suggestion immediately below the agent group becomes the selected visual target, and Tab inserts that thread mention and closes the menu.

## chat-composer-mentions-012

Original test `Composer-anchored mentions reset after filtering and preserve IME confirmation and Escape (new chat: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L487).

- **Given** A user is composing in an existing chat and has selected Private Ops from the unfiltered mention suggestions.
- **When** They replace the query with “@zeta”, confirm Enter during IME composition, end composition, press ArrowDown, press Escape, then click the composer again.
- **Then** Filtering selects Zeta Agent. Enter during composition leaves the menu open and does not insert a mention; after composition ends, ArrowDown removes the active selection. Escape closes the menu while preserving “@zeta”. Clicking the composer reopens the menu with Zeta Agent selected.

## chat-composer-mentions-013

Original test `Composer-anchored mentions reset after filtering and preserve IME confirmation and Escape (new chat: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L487).

- **Given** A user is composing a new chat and has selected Private Ops from the unfiltered mention suggestions.
- **When** They replace the query with “@zeta”, confirm Enter during IME composition, end composition, press ArrowDown, press Escape, then click the composer again.
- **Then** Filtering selects Zeta Agent. Enter during composition leaves the menu open and does not insert a mention; after composition ends, ArrowDown removes the active selection. Escape closes the menu while preserving “@zeta”. Clicking the composer reopens the menu with Zeta Agent selected.

## chat-composer-mentions-014

Original test `Save a selected agent mention and retain it when returning to the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L526).

- **Given** A user is composing in an existing chat that has a saved draft containing a Zeta Agent mention; Zeta Agent has a current avatar.
- **When** They select Zeta Agent from the mention suggestions, open the chat with the saved draft, and return to the original chat.
- **Then** The suggestion and inserted mention show Zeta Agent’s current avatar, and the inserted mention is saved in the draft. The saved mention remains visible when the user returns to the original chat.

## chat-composer-mentions-015

Original test `Mention a chat thread from any agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L570).

- **Given** A user is composing in a chat with “Project Alpha” associated with Scout and “Other Alpha” associated with Reviewer.
- **When** They type “Review @alpha” and select “Other Alpha.”
- **Then** Both thread suggestions show the avatar of their associated agent. Selecting “Other Alpha” inserts that thread mention and saves the reference in the draft.

## chat-composer-mentions-016

Original test `Personal Okou mentions preserve authorized chat references without Agent destinations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.test.tsx#L621).

- **Given** A user is composing a new chat in personal Okou, where the available suggestions include the chat thread “Zeta launch notes” but no Agent destinations.
- **When** They type “Review @Zeta” and select “Zeta launch notes.”
- **Then** No “Zeta Agent” suggestion is shown. The composer displays “Review Zeta launch notes” with a chat-thread mention for that thread.
