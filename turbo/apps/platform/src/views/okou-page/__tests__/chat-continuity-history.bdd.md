# Chat continuity history

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-history.test.tsx](chat-continuity-history.test.tsx).

## chat-continuity-history-001

Original test `Render the latest turns of a long conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L222).

- **Given** A long conversation contains repeated requests and older turns, including one repeated request with a PDF attachment.
- **When** The user opens the conversation.
- **Then** The latest answers are rendered, including the final repeated-request answer and the most recent answer, while the neighboring answer before the repeated requests is not initially rendered. The message composer is visible, and the final repeated-request answer has one history anchor.

## chat-continuity-history-002

Original test `Page older conversation history without losing turn anchors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L239).

- **Given** A long conversation initially shows its latest turns, but its earliest retained request is not visible.
- **When** The user scrolls upward twice to page through older history.
- **Then** The older neighboring answer and the launch-evidence.pdf attachment appear, along with the first and second results for the repeated request. Further paging reveals the earliest retained request and answer. The relevant earliest, neighboring, and later turns each retain exactly one history anchor.

## chat-continuity-history-003

Original test `Navigate chat history with scroll controls and keyboard commands`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L270).

- **Given** A conversation has six request-and-answer turns and is scrolled up from the bottom.
- **When** The user selects Scroll to bottom, then focuses the conversation and presses Control+ArrowUp.
- **Then** Scroll to bottom returns the conversation to its bottom, hides the bottom-scroll control, and leaves the sixth answer visible. Control+ArrowUp moves the conversation to the top, where the bottom-scroll control is visible.

## chat-continuity-history-004

Original test `Keep both open chats live without mixing their messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L326).

- **Given** The main and side chat panes are open, each with its own existing request and answer.
- **When** New live replies arrive for both conversations.
- **Then** Each pane displays only its own new reply; neither pane shows the other conversation's reply, and both panes remain visible.

## chat-continuity-history-005

Original test `Confirm a message for a new run in split chats without duplicating it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L405).

- **Given** The user has two open chat panes, the main chat has no active run, and the side chat has its own existing answer.
- **When** The user sends “Send this exactly once” in the main chat and the server confirms it with an answer.
- **Then** The message appears exactly once in the main chat, is associated with the main chat, and is not shown in the side chat. After confirmation, the queued message is gone, the temporary unconfirmed turn is replaced by one confirmed turn and anchor, and the acknowledged answer appears; both panes remain visible.

## chat-continuity-history-006

Original test `Confirm a message for an active run in split chats without duplicating it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L405).

- **Given** The user has two open chat panes, the main chat has an active run, and the side chat has its own existing answer.
- **When** The user sends “Steer this active run once” in the main chat and the server confirms it with an answer.
- **Then** The active run is indicated before sending. The message appears exactly once in the main chat and not in the side chat. After confirmation, the queued message is gone, the temporary unconfirmed turn is replaced by one confirmed turn and anchor, and the acknowledged answer appears; both panes remain visible.
