# Chat composer ime

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-ime.test.tsx](chat-composer-ime.test.tsx).

## chat-composer-ime-001

Original test `Filter slash workflows throughout IME composition without taking candidate keys`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ime.test.tsx#L65).

- **Given** The chat composer offers workflows named “Review PR 123,” “Review PR 124,” and “Prepare a recap.”
- **When** The user types “/” and begins IME composition, changing the candidate query from “pr123” to “p r123” and then “p r124.” They press ArrowDown, ArrowUp, Enter, Tab, and Escape while composing, including Enter without the native composing flag, then commit “pr124” and press Enter to select the workflow.
- **Then** The slash menu filters to “/pr-123-review” for both “pr123” and “p r123,” and to “/pr-124-review” for “p r124” and committed “pr124.” Candidate keys leave the editor focused and its text unchanged; after selection, the editor contains “/pr-124-review ” and the menu closes.

## chat-composer-ime-002

Original test `Clear a cancelled IME query and keep committed spaces as slash boundaries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ime.test.tsx#L124).

- **Given** The chat composer offers workflows including “/weekly-recap” and “/pr-123-review.”
- **When** The user types “/”, composes “p r123,” then cancels the composition by clearing its text. They subsequently enter “/pr123 details” as committed text.
- **Then** After composition cancellation, the editor contains only “/” and the slash menu again includes “/weekly-recap.” The committed text remains “/pr123 details,” and the slash menu is closed.
