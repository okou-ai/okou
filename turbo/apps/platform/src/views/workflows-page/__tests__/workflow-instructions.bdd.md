# Workflow instructions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [workflow-instructions.test.tsx](workflow-instructions.test.tsx).

## workflow-instructions-001

Original test `Opening instructions and undoing an edit leave the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L49).

- **Given** The workflow instructions contain saved Markdown text.
- **When** The user focuses the editor, replaces its content, and undoes the edit.
- **Then** The original saved content returns and the unsaved-changes indicator disappears.

## workflow-instructions-002

Original test `Opening Markdown file and undoing an edit leave the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L49).

- **Given** The workflow Markdown file notes.md contains saved Markdown text.
- **When** The user focuses the editor, replaces its content, and undoes the edit.
- **Then** The original saved content returns and the unsaved-changes indicator disappears.

## workflow-instructions-003

Original test `Retain the instructions draft on failure and clear it only after a successful save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L89).

- **Given** The workflow instructions are saved, and an attempted update will initially fail with a conflict.
- **When** The user edits the instructions and saves, then retries after the conflict is no longer returned.
- **Then** After the failed save, the draft remains, the unsaved indicator remains, and Save is enabled. After the successful retry, the unsaved indicator clears and the submitted update contains the new instructions.

## workflow-instructions-004

Original test `Retain the Markdown file draft on failure and clear it only after a successful save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L89).

- **Given** The workflow Markdown file notes.md is saved, and an attempted update will initially fail with a conflict.
- **When** The user edits the file content and saves, then retries after the conflict is no longer returned.
- **Then** After the failed save, the draft remains, the unsaved indicator remains, and Save is enabled. After the successful retry, the unsaved indicator clears and the submitted update contains the new notes.md content.

## workflow-instructions-005

Original test `Discard restores instructions and clears the discarded undo history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L160).

- **Given** The workflow instructions are saved, and the user has made an unsaved edit.
- **When** They discard the edit and then try to undo it before making another edit.
- **Then** The saved instructions return, the unsaved indicator stays absent, and undo does not restore the discarded edit. A subsequent edit is shown as unsaved.

## workflow-instructions-006

Original test `Discard restores Markdown file and clears the discarded undo history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflow-instructions.test.tsx#L160).

- **Given** The workflow Markdown file notes.md is saved, and the user has made an unsaved edit.
- **When** They discard the edit and then try to undo it before making another edit.
- **Then** The saved file content returns, the unsaved indicator stays absent, and undo does not restore the discarded edit. A subsequent edit is shown as unsaved.
