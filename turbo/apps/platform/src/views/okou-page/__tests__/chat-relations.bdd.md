# Chat relations

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-relations.test.tsx](chat-relations.test.tsx).

## chat-relations-001

Original test `Draw the source and related chats together once children answer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L170).

- **Given** The chat has a Slack source and a related created chat, while the children response is pending.
- **When** The resource panel is opened before that response arrives, then the response completes.
- **Then** The panel shows a loading indicator without the Slack source initially; afterward it shows both the Slack source and related chat, with loading cleared.

## chat-relations-002

Original test `Draw the source and related chats together once communications answer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L170).

- **Given** The chat has a Slack source and a related created chat, while the communications response is pending.
- **When** The resource panel is opened before that response arrives, then the response completes.
- **Then** The panel shows a loading indicator without the Slack source initially; afterward it shows both the Slack source and related chat, with loading cleared.

## chat-relations-003

Original test `Keep loaded relationships visible when another source fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L222).

- **Given** The children relationship list returns a created chat and the communications list fails with a server error.
- **When** The resource panel loads.
- **Then** The created chat remains visible despite the other relationship request failing.

## chat-relations-004

Original test `Start the next chat closed and draw its panel once its relationships answer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L248).

- **Given** The user is viewing the first chat, which lists a second chat as related; the second chat's communications request is pending.
- **When** The user opens the second chat and then its resource panel before communications load.
- **Then** The panel initially shows loading rather than stale content from the first chat; once its relationships answer, it shows the second chat's created child and does not list the second chat itself as a related chat.

## chat-relations-005

Original test `Show the first source and created chats with their status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L308).

- **Given** The chat prompt has a Slack source, two created chats, and a running related chat with a message history.
- **When** The user opens the resource panel and hovers over the created-chat link.
- **Then** The Slack source links to its original Slack URL; both created chats link to their chats and have no running status, while the existing related chat links to its chat and shows Running. Its separate history control is initially closed, and the created-chat title reveals on hover with a 925 ms duration and stops revealing on pointer exit.

## chat-relations-006

Original test `Keep an unknown first-run origin when a later run has a Slack source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L372).

- **Given** The first run has no source, a later run has a Slack source, and a related chat exists.
- **When** The user opens the resource panel.
- **Then** The related chat is shown, but no source section or Slack original-message link is shown for the later run's source.

## chat-relations-007

Original test `Link the first-run agent source directly to its parent run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L396).

- **Given** The first run has an agent source identifying a parent chat and run, with no relationship listing that parent chat.
- **When** The user opens the resource panel and hovers over the parent-chat origin link.
- **Then** The origin is linked directly to the parent chat's specified run and marked From within the Chats list, which has one item; no separate From region appears. The title reveals on hover with a 925 ms duration and stops revealing on pointer exit.

## chat-relations-008

Original test `List an agent origin once when it is also a related chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L452).

- **Given** The first run has an agent source identifying a parent chat, and that parent also appears as a related chat alongside a created child.
- **When** The user opens the resource panel.
- **Then** The parent appears once in the Chats list, linked to its chat and marked From; the list has two items, with no separate parent-origin entry or From region.

## chat-relations-009

Original test `Keep the agent origin first in the collapsed preview when it is the oldest related chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L490).

- **Given** The first run has an agent source identifying the oldest related chat; there are three created children, and that oldest chat has a more recent communication timestamp than the children.
- **When** The user opens the Chats section and expands the collapsed preview.
- **Then** The three-item collapsed preview puts the agent-origin chat first and marks it From; the third child is initially hidden, then appears when the list expands, bringing the list to four items.

## chat-relations-010

Original test `Open a related chat's messages and link each to the run it started`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L529).

- **Given** A related chat has a sent message that started a run in that chat, a received message that started a run in the current chat, and a sent message that has not started a run.
- **When** The user opens the related chat's message history and then closes it.
- **Then** The history opens and shows the sent message linked to the related chat's run, marked Sent; the received message links to the current chat's run, marked Received; and the not-yet-started message links to the related chat without a run fragment. Closing the history hides its messages.

## chat-relations-011

Original test `Follow a sent message card to the run it started in the other chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L572).

- **Given** A related chat's open message history contains a sent message that started a run in that chat.
- **When** The user follows the sent message card.
- **Then** Navigation goes to the related chat and its started run.

## chat-relations-012

Original test `Open a related chat from its row in one click, while its caret opens the history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L593).

- **Given** A related chat has a received message in its message history.
- **When** The user opens its history with the separate history control, then clicks the related-chat row.
- **Then** The received message links to the current chat's run; the related-chat row links to the related chat and navigates there in one click.

## chat-relations-013

Original test `Keep received messages usable when the other chat is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L618).

- **Given** A related chat is unavailable and has no title, while its message history contains both sent and received messages.
- **When** The user opens the unavailable chat's message history.
- **Then** The row is labeled Unavailable and is not a link; the received message remains a link to the current chat's run, while the sent message is not a link.

## chat-relations-014

Original test `Show empty chats and unavailable relationship targets without inventing an origin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L638).

- **Given** The current chat has no events, and its children list contains a chat with no title and unavailable status.
- **When** The user opens the resource panel.
- **Then** The relationship target appears as Unavailable and is not a link; a Chats section is present, but no From section is invented.

## chat-relations-015

Original test `Keep other sections visible when a relationship list fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L664).

- **Given** The children relationship request fails with a server error, while communications returns a related chat.
- **When** The user opens the resource panel.
- **Then** A Could not load message appears for the failed relationship list, while the existing related chat remains visible.

## chat-relations-016

Original test `Show artifacts without an empty related chats section`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L689).

- **Given** The chat has an artifact and no related chats.
- **When** The user opens the resource panel.
- **Then** The artifact is visible, and no empty Chats section is shown.

## chat-relations-017

Original test `Show a queued related chat's status as text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L710).

- **Given** A related chat has queued status and a sent-message count of 21.
- **When** The user opens the resource panel.
- **Then** The related chat shows Queued as text and does not show Running.

## chat-relations-018

Original test `Dismiss the relations-only panel with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L726).

- **Given** The resource panel is open and shows a related chat, with no chat events or artifacts.
- **When** The user presses Escape.
- **Then** The panel closes and its trigger reports that it is no longer expanded.

## chat-relations-019

Original test `Preview three unique chats and expand the complete list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L742).

- **Given** The chat has a Slack source and 51 created chats, one of which is also returned as a running communication.
- **When** The user opens the Chats section, expands the list, then collapses it.
- **Then** The initial preview contains three unique chats, with the duplicate Child 1 listed once and marked Running rather than Created. Expanding shows all 51 chats; collapsing hides Child 4 and leaves the Slack source visible.

## chat-relations-020

Original test `Close an open message history when the Chats section collapses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L786).

- **Given** The Chats section has four created chats, including a related chat with a message history that is open.
- **When** The user collapses the expanded Chats section.
- **Then** The message history closes and its message is no longer visible.

## chat-relations-021

Original test `Show exactly three related chats without an expand control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-relations.test.tsx#L825).

- **Given** The chat has exactly three created related chats.
- **When** The user opens the Chats section.
- **Then** All three chats are shown and no Show more control is available.
