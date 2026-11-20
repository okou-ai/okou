# Chat composer workflows

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-workflows.test.tsx](chat-composer-workflows.test.tsx).

## chat-composer-workflows-001

Original test `Multiple inline templates preserve every reference when you send`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L151).

- **Given** A restored chat draft contains two presentation templates.
- **When** The user sends the draft.
- **Then** The sent message preserves both template titles and both structured references in their original order, and the composer is cleared.

## chat-composer-workflows-002

Original test `Insert an attached workflow with slash suggestions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L217).

- **Given** The chat offers sales-research, support-escalation, and research-digest workflows.
- **When** The user types `/`, searches for `ReSeArCh`, then moves down twice and presses Enter.
- **Then** Matching suggestions appear with research-digest ranked before sales-research, and the match in sales-research is emphasized. The selected workflow is inserted as `/sales-research`, with one workflow highlight, and the suggestions close.

## chat-composer-workflows-003

Original test `Reopen workflow suggestions after clearing a pending draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L269).

- **Given** The workflow list request for `pr-review` is pending while the user has entered `/pr`.
- **When** The user clears the draft, re-enters `/pr`, waits for the request, then clears and searches again after the available list is empty, and selects the displayed result.
- **Then** The pending search is reopened and shows `/pr-review`; selecting it inserts and highlights `/pr-review` in the composer.

## chat-composer-workflows-004

Original test `Find and insert a workflow with an abbreviated name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L311).

- **Given** The available workflows are `pr-design-acceptance-url`, `pr-url-design-acceptance`, and `pr-auto`.
- **When** The user types `Review /PdAu` and presses Enter on the matching suggestion.
- **Then** Only `/pr-design-acceptance-url` is suggested, with the matching abbreviation letters `p`, `d`, `a`, and `u` emphasized. The composer reads `Review /pr-design-acceptance-url` and the suggestions close.

## chat-composer-workflows-005

Original test `Keep exact workflow names at the top ahead of prefixes, substrings, and abbreviations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L350).

- **Given** The available workflows are `pr-audit-report`, `team-pr-auto`, `pr-auto-deploy`, and `pr-auto`.
- **When** The user searches for `/pr-auto` and presses Enter.
- **Then** Suggestions are ordered exactly as `/pr-auto`, `/pr-auto-deploy`, `/team-pr-auto`, and `/pr-audit-report`. The exact match is inserted and the suggestions close.

## chat-composer-workflows-006

Original test `Send a template while the current run is active`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L386).

- **Given** A presentation template is selected in a chat with an active run.
- **When** The user sends the template.
- **Then** The composer clears, and the sent message displays the template title as a structured reference.

## chat-composer-workflows-007

Original test `Use the workflow template picker to send a workflow template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L419).

- **Given** The Workflow template picker contains the GitHub PR summarizer template.
- **When** The user searches for that template, selects it, and sends it.
- **Then** The template appears inline in the composer, and the sent message includes the template title and a structured reference.

## chat-composer-workflows-008

Original test `Workflow category filters narrow templates and preserve the search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L469).

- **Given** The Workflow template picker includes Auto-inbox label and GitHub PR summarizer templates.
- **When** The user selects Everyone, searches for `merged pull requests`, then selects Engineering.
- **Then** Everyone is pressed and Auto-inbox label is shown while GitHub PR summarizer is hidden. The search remains `merged pull requests` after switching categories; GitHub PR summarizer is shown and Auto-inbox label is hidden.

## chat-composer-workflows-009

Original test `Wait for a template attachment before sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L508).

- **Given** A presentation template is selected and `brief.txt` is still uploading.
- **When** The user tries to send before the upload finishes, then the upload completes.
- **Then** Send is disabled during upload, and the attempted send does not send a message. After completion, Send is enabled, the file remains attached with a remove option, and the template remains in the composer.

## chat-composer-workflows-010

Original test `Distinguish workflow tokens from text inside URLs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L571).

- **Given** The available workflow is `pr-review`.
- **When** The user enters `/pr-review ` and then types `https://www.okou.ai/en/use-cases/pr-review`.
- **Then** The URL remains visible as text, the workflow token remains the only highlighted workflow, and no suggestion menu is open.

## chat-composer-workflows-011

Original test `Highlight a workflow in a restored draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-workflows.test.tsx#L597).

- **Given** A restored chat draft contains `Please run /pr-review`, and `pr-review` is available.
- **When** The chat draft is restored.
- **Then** `/pr-review` is highlighted as a workflow in the composer.
