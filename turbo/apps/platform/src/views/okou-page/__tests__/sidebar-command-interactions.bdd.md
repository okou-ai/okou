# Sidebar command interactions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-command-interactions.test.tsx](sidebar-command-interactions.test.tsx).

## sidebar-command-interactions-001

Original test `Pin one highlighted search result with Enter and preserve the query`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-command-interactions.test.tsx#L36).

- **Given** The sidebar has Nova pinned and the pin manager lists Research Agent before Support Agent. The search query is “Agent.”
- **When** The user moves the highlighted result down to Support Agent and presses Enter.
- **Then** Support Agent is pinned once and appears after Nova. The manager remains open, the query stays “Agent,” and Support Agent can be unpinned.

## sidebar-command-interactions-002

Original test `Hand off from the pin manager to the create-agent dialog and back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-command-interactions.test.tsx#L69).

- **Given** The sidebar has Nova pinned and the pin manager is open.
- **When** The user chooses New agent, then presses Escape in the create-agent dialog.
- **Then** The create-agent dialog opens with its Name field focused, replacing the pin manager. Escape closes it and returns focus to the pin control.

## sidebar-command-interactions-003

Original test `Create the first agent from an empty pin manager with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-command-interactions.test.tsx#L99).

- **Given** The user has only the default agent, and the pin manager has no other agents to show.
- **When** The user selects the empty manager’s next command with ArrowDown and presses Enter.
- **Then** The create-agent dialog opens.

## sidebar-command-interactions-004

Original test `Move the pin control to the header once agents fill the first grid row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-command-interactions.test.tsx#L120).

- **Given** Nova, Research Agent, and Support Agent are pinned, filling the first grid row; the pin control is in the grid.
- **When** The user pins Operations Agent and presses Escape to close the manager.
- **Then** Operations Agent appears after the existing agents. The grid no longer contains the pin control; the header pin control has focus after the manager closes.
