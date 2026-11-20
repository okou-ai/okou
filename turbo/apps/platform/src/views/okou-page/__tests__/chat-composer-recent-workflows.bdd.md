# Chat composer recent workflows

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-recent-workflows.test.tsx](chat-composer-recent-workflows.test.tsx).

## chat-composer-recent-workflows-001

Original test `The overview fills from the alphabet and expanding preserves the visible workflows' order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L112).

- **Given** The workflow menu is open and several workflows are available.
- **When** The user views the overview and expands it.
- **Then** The overview lists /alpha, /beta, /charlie, and /delta in alphabetical order. Expanding adds /echo and /zulu without changing the order of the visible workflows.

## chat-composer-recent-workflows-002

Original test `An abandoned workflow selection at /chats/b0000000-0000-4000-a000-000000000920 does not change recency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L124).

- **Given** The user is composing a chat at /chats/b0000000-0000-4000-a000-000000000920, and the workflow menu is open.
- **When** The user selects /echo, then resumes drafting without sending it.
- **Then** The menu returns to its default first four workflows: /alpha, /beta, /charlie, and /delta. The abandoned selection does not change recency.

## chat-composer-recent-workflows-003

Original test `An abandoned workflow selection at /agents/e0000000-0000-4000-a000-000000000010/chat does not change recency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L124).

- **Given** The user is composing an agent chat at /agents/e0000000-0000-4000-a000-000000000010/chat, and the workflow menu is open.
- **When** The user selects /echo, then resumes drafting without sending it.
- **Then** The menu returns to its default first four workflows: /alpha, /beta, /charlie, and /delta. The abandoned selection does not change recency.

## chat-composer-recent-workflows-004

Original test `An accepted zulu send at /agents/e0000000-0000-4000-a000-0000000… promotes the workflow from []`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L169).

- **Given** The user is composing an agent chat with no recent workflows.
- **When** The user sends /zulu and then opens the workflow menu again.
- **Then** The menu lists /zulu first, followed by /alpha, /beta, and /charlie.

## chat-composer-recent-workflows-005

Original test `An accepted zulu send at /chats/b0000000-0000-4000-a000-00000000… promotes the workflow from []`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L169).

- **Given** The user is composing an existing chat with no recent workflows.
- **When** The user sends /zulu and then opens the workflow menu again.
- **Then** The menu lists /zulu first, followed by /alpha, /beta, and /charlie.

## chat-composer-recent-workflows-006

Original test `An accepted echo send at /chats/b0000000-0000-4000-a000-00000000… promotes the workflow from [ 'zulu' ]`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L169).

- **Given** The user is composing an existing chat with /zulu as the most recent workflow.
- **When** The user sends /echo and then opens the workflow menu again.
- **Then** The menu lists /echo, /zulu, /alpha, and /beta, in that order.

## chat-composer-recent-workflows-007

Original test `An accepted zulu send at /chats/b0000000-0000-4000-a000-00000000… promotes the workflow from [ 'echo', 'zulu' ]`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L169).

- **Given** The user is composing an existing chat with /echo more recent than /zulu.
- **When** The user sends /zulu and then opens the workflow menu again.
- **Then** The menu lists /zulu, /echo, /alpha, and /beta, in that order.

## chat-composer-recent-workflows-008

Original test `An open menu keeps its order when an earlier send finishes, then refreshes on reopening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L216).

- **Given** The workflow menu is open while a /zulu send is still pending.
- **When** The send finishes while the menu remains open, and the user expands the menu before closing and reopening it.
- **Then** The already-open menu retains its original order during the pending send and after it finishes, including /alpha, /beta, /charlie, /delta, /echo, and /zulu when expanded. Reopening refreshes the order to show /zulu first.

## chat-composer-recent-workflows-009

Original test `An accepted use retains history written by another browser tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L264).

- **Given** The user has previously used /zulu, and another browser tab updates recent-workflow history to put /echo ahead of /zulu.
- **When** The user sends /delta and reopens the workflow menu.
- **Then** The menu lists /delta, /echo, /zulu, and /alpha, preserving the history written by the other tab.

## chat-composer-recent-workflows-010

Original test `Persisted local recency ignores unavailable workflow ids`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L300).

- **Given** Saved workflow history contains an unavailable workflow ID followed by the ID for /echo.
- **When** The user opens the workflow menu.
- **Then** The unavailable workflow is ignored, and the menu lists /echo, /alpha, /beta, and /charlie.

## chat-composer-recent-workflows-011

Original test `Typed search keeps name matches ahead of more recently used description matches`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L317).

- **Given** All available workflows have saved recent-use history, and the workflow menu is open.
- **When** The user types “a” to search.
- **Then** Name matches appear ahead of description-only matches, in this order: /alpha, /delta, /beta, /charlie, /zulu, /echo.

## chat-composer-recent-workflows-012

Original test `The pr-a search ranks recently used prefixes above substrings, abbreviations, and descriptions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L340).

- **Given** The workflow menu contains pr-a-related names and a description mentioning “pr-auto”; /report and /team-pr-auto are recently used ahead of /pr-auto and /pr-auto-deploy.
- **When** The user searches for “Pr-A”, then narrows the search to “/pr-auto-deploy” and presses Enter.
- **Then** The first search orders results as /pr-auto, /pr-auto-deploy, /pr-audit, /team-pr-auto, /report, and /presentation-restart-auto, ranking recent prefixes above substrings, abbreviations, and description matches. The narrowed search shows only /pr-auto-deploy; pressing Enter inserts it in the composer and closes the menu.

## chat-composer-recent-workflows-013

Original test `The latest accepted use wins regardless of frequency on desktop and mobile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L409).

- **Given** The user has sent /qz-delta twice and then /qz-beta once.
- **When** The user searches workflows beginning with /qz on desktop and on mobile, and uses ArrowDown then Enter in each layout.
- **Then** In both layouts, /qz-beta appears first despite being used fewer times than /qz-delta, and it is initially active. ArrowDown and Enter insert /qz-delta into the draft and close the menu.

## chat-composer-recent-workflows-014

Original test `A rejected send does not promote a workflow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L438).

- **Given** The user is composing a chat and the send request for /zulu is rejected with a 400 error stating “Message was not accepted.”
- **When** The user attempts the send and then reopens the workflow menu.
- **Then** The rejection message is displayed, and /zulu is not promoted; the menu begins with /alpha, /beta, /charlie, and /delta.

## chat-composer-recent-workflows-015

Original test `Typed results keep their order and keyboard selection while an earlier send finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-recent-workflows.test.tsx#L461).

- **Given** The user has sent /qz-delta, and another send is pending while the workflow menu is open with a /qz search.
- **When** The user presses ArrowDown, the pending send finishes, and the user presses Enter.
- **Then** The result order remains /qz-alpha, /qz-beta, /qz-charlie, /qz-delta, /qz-echo, and /qz-zulu while the send finishes. /qz-beta remains active and is inserted into the draft; reopening the search then lists /qz-delta first.
