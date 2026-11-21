# Agent instructions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agent-instructions.test.tsx](agent-instructions.test.tsx).

## agent-instructions-001

Original test `Switching to Instructions ending in a heading leaves the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L78).

- **Given** The saved instructions are “# Release risks,” and the user is viewing the agent profile.
- **When** The user switches to Instructions and focuses the editor.
- **Then** The instructions remain saved, and no unsaved-changes bar appears.

## agent-instructions-002

Original test `Switching to Instructions ending in a list leaves the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L78).

- **Given** The saved instructions are “# Team\n\n* **Research lead**: verify sources,” and the user is viewing the agent profile.
- **When** The user switches to Instructions and focuses the editor.
- **Then** The instructions remain saved, and no unsaved-changes bar appears.

## agent-instructions-003

Original test `Switching to Instructions ending in a blockquote leaves the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L78).

- **Given** The saved instructions are “> Verify every source,” and the user is viewing the agent profile.
- **When** The user switches to Instructions and focuses the editor.
- **Then** The instructions remain saved, and no unsaved-changes bar appears.

## agent-instructions-004

Original test `Switching to Instructions ending in a code block leaves the content saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L78).

- **Given** The saved instructions are a text code block containing “Review release notes,” and the user is viewing the agent profile.
- **When** The user switches to Instructions and focuses the editor.
- **Then** The instructions remain saved, and no unsaved-changes bar appears.

## agent-instructions-005

Original test `Undoing an instruction edit restores the saved state: Review release notes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L103).

- **Given** The saved instructions are “Review release notes.”
- **When** The user replaces them with “Unsaved release draft” and undoes the edit.
- **Then** The editor returns to “Review release notes,” and the unsaved-changes bar disappears.

## agent-instructions-006

Original test `Undoing an instruction edit restores the saved state: # Team * **Research lead**: verify sources`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L103).

- **Given** The saved instructions are “# Team\n\n* **Research lead**: verify sources.”
- **When** The user replaces them with “Unsaved release draft” and undoes the edit.
- **Then** The editor returns to the saved heading and list, and the unsaved-changes bar disappears.

## agent-instructions-007

Original test `Discard restores saved instructions and exits editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L122).

- **Given** The saved instructions are “Review release notes,” and the user has edited them to “Unsaved instructions.”
- **When** The user discards the edit.
- **Then** The editor shows “Review release notes,” and the unsaved-changes bar disappears.

## agent-instructions-008

Original test `Agent instructions receive external updates with SingleAgent disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L139).

- **Given** The agent instructions page is open with SingleAgent disabled and initially shows “Original instructions.”
- **When** An external instructions-changed event occurs and the refreshed instructions are “Instructions saved elsewhere.”
- **Then** The editor updates to “Instructions saved elsewhere.”
- **Upstream change** `4e5707de` (#49556) removes the SingleAgent switch, and the default agent's `/agents/<id>` page now redirects to My Okou settings, so this page is reached only for a retained non-default agent; the upstream test is now `Agent instructions receive external updates on a retained agent` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L141)). Rebuild this scenario on a non-default agent's `/agents/<id>?tab=instructions` page with no SingleAgent setting.

## agent-instructions-009

Original test `Agent drafts survive external changes and can reload the newer instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L159).

- **Given** The agent instructions page shows “Original instructions,” and the user has an unsaved draft, “Draft to keep.”
- **When** An external change provides “Newer instructions,” then the user chooses to reload saved instructions.
- **Then** The external change notice appears while the draft remains in the editor and saving is disabled; reloading replaces the draft with “Newer instructions” and removes the unsaved-changes bar.

## agent-instructions-010

Original test `Returning to the tab refreshes legacy instructions without a notification`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L196).

- **Given** The agent instructions page shows “Original instructions.”
- **When** The user leaves the browser tab and returns after instructions have changed to “Saved while away.”
- **Then** The editor refreshes to “Saved while away” without a notification requirement.

## agent-instructions-011

Original test `A legacy save conflict keeps the draft until discard reloads the latest instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L215).

- **Given** The agent instructions page shows “Original instructions,” and the user has an unsaved draft, “Local draft.” The latest saved instructions elsewhere are “Newer instructions.”
- **When** The user saves and receives a conflict, then discards the draft.
- **Then** The draft remains visible after the conflict and saving is disabled; discarding reloads “Newer instructions” and removes the unsaved-changes bar.

## agent-instructions-012

Original test `Saving instructions disables both unsaved actions until the update completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L250).

- **Given** The saved instructions are “Review release notes,” and the user has edited them to “Check launch readiness.”
- **When** The user saves while the update is still pending, then the update completes.
- **Then** Both Save and Discard are disabled while the update is pending. After completion, a saved confirmation appears, the unsaved-changes bar disappears, and the editor retains “Check launch readiness.”

## agent-instructions-013

Original test `A user can format and save agent instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L281).

- **Given** The saved instructions are “Review release notes.”
- **When** The user replaces them with “Launch risks,” formats the text as a level-two heading, and saves.
- **Then** Formatting controls for bold, italic, strikethrough, inline code, three heading levels, bullet and ordered lists, and blockquote are enabled and have no title attribute. The saved update contains “## Launch risks,” the editor displays it as a heading, and a saved confirmation appears.

## agent-instructions-014

Original test `Instructions keep plus signs literal and save underline as HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-instructions.test.tsx#L332).

- **Given** The saved instructions are “Use C++ and i++ in ++legacy notes++.”
- **When** The user underlines the entire text and saves.
- **Then** The plus signs remain literal, and the saved content is “<u>Use C++ and i++ in ++legacy notes++</u>.”
