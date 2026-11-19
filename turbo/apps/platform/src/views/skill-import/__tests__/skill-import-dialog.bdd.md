# Skill import dialog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [skill-import-dialog.test.tsx](skill-import-dialog.test.tsx).

## skill-import-dialog-001

Original test `Import skills sits before Create in chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L171).

- **Given** A user is on the Workflows page.
- **When** The page displays its primary actions.
- **Then** “Import skills” appears immediately before “Create in chat.”

## skill-import-dialog-002

Original test `Import skills opens a Claude Code prompt by default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L182).

- **Given** A user is on the Workflows page with no workflows.
- **When** They open Import skills using the default tool.
- **Then** The dialog selects Claude Code, presents the import instructions and a folded prompt, and offers an empty imported-skills message. Expanding the prompt shows a Claude Code session token and ~/.claude/skills/, not ~/.codex/skills/.

## skill-import-dialog-003

Original test `Switching the dialog to Codex writes the prompt for Codex`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L222).

- **Given** A user opens Import skills and expands the default Claude Code prompt.
- **When** They select Codex.
- **Then** The prompt updates to a Codex session token and ~/.codex/skills/, not ~/.claude/skills/. The instructions say to open the Codex app and start a New chat, and not to use the Code tab.

## skill-import-dialog-004

Original test `The empty workflow list offers the import`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L248).

- **Given** A user has no workflows on the Workflows page.
- **When** They select “Import from Claude Code or Codex.”
- **Then** The import dialog opens and its Copy prompt action becomes visible.

## skill-import-dialog-005

Original test `Browser-owned View workflows activations keep the dialog listening for imports`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L260).

- **Given** A user opens the import dialog and the “View workflows” link points to /workflows.
- **When** They activate the link with Control, Meta, Shift, or Alt held, or with the middle or right mouse button, then an imported Claude Code workflow arrives.
- **Then** The import dialog stays open through those browser-owned link activations and displays the imported workflow with “1 imported · listening for more.”

## skill-import-dialog-006

Original test `View workflows click closes the import dialog and navigates in the current tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L301).

- **Given** A user opens the import dialog from /workflows?source=skill-import.
- **When** They activate “View workflows” by clicking it.
- **Then** The dialog closes and the current page navigates to /workflows with no query string.

## skill-import-dialog-007

Original test `View workflows Enter closes the import dialog and navigates in the current tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L301).

- **Given** A user opens the import dialog from /workflows?source=skill-import.
- **When** They focus “View workflows” and press Enter.
- **Then** The dialog closes and the current page navigates to /workflows with no query string.

## skill-import-dialog-008

Original test `An imported workflow is tagged with the tool it came from`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L329).

- **Given** The Workflows page contains a Codex-imported workflow, a Claude Code-imported workflow, and a workflow made in Okou.
- **When** The workflow list renders.
- **Then** The first is tagged “Imported from Codex,” the second “Imported from Claude Code,” and the workflow made in Okou has no imported-from tag.

## skill-import-dialog-009

Original test `The dialog lists only workflows the import tagged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L367).

- **Given** A user has opened the import dialog and an ordinary workflow made in chat and a Claude Code-imported workflow arrive.
- **When** The dialog updates its imported-workflow list.
- **Then** It lists the Claude Code-imported workflow and omits the workflow made in chat.

## skill-import-dialog-010

Original test `Reopening retains the prompt and resyncs the whole session including closed-window uploads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L396).

- **Given** A user opens the import dialog, sees one Claude Code upload arrive, and closes the dialog.
- **When** Another upload arrives while the dialog is closed and the user reopens it.
- **Then** The page list updates with the first import, and the reopened dialog shows both workflows while retaining the exact original prompt.

## skill-import-dialog-011

Original test `An upload before subscription attachment is recovered without replacing the prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L455).

- **Given** A user opens the import dialog using message-port transport while attachment of its realtime subscription is deferred.
- **When** A Claude Code upload arrives before the subscription attaches, then the subscription attaches.
- **Then** The dialog recovers the uploaded workflow without changing the expanded prompt.

## skill-import-dialog-012

Original test `A continuity gap resyncs missed uploads without issuing another prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L487).

- **Given** A user opens the import dialog and a Claude Code upload occurs while the realtime connection is suspended, without a notification.
- **When** The connection becomes connected again.
- **Then** The dialog recovers the missed workflow without changing the expanded prompt.

## skill-import-dialog-013

Original test `Changing the signed-in identity closes the old import and releases its subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L524).

- **Given** A signed-in user has the import dialog open with its realtime subscription active.
- **When** The signed-in identity changes.
- **Then** The dialog closes and its realtime subscription is released.

## skill-import-dialog-014

Original test `Escape closes the import, releases realtime, and returns keyboard focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/skill-import/__tests__/skill-import-dialog.test.tsx#L554).

- **Given** A user opens the import dialog from its trigger while the trigger has keyboard focus.
- **When** They press Escape.
- **Then** The dialog closes, realtime is released, and keyboard focus returns to the trigger.
