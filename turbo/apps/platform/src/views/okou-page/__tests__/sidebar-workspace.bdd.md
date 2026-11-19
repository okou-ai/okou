# Sidebar workspace

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sidebar-workspace.test.tsx](sidebar-workspace.test.tsx).

## sidebar-workspace-001

Original test `Filter workspace search to matching messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L117).

- **Given** The workspace search returns a title match for “Deployment notes” and a message match for “Incident response” for “deploy”.
- **When** The user filters the results to Messages.
- **Then** “Incident response” remains visible and “Deployment notes” is absent.

## sidebar-workspace-002

Original test `Show running and unread chat states in workspace search results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L139).

- **Given** Workspace search returns “Deployment notes” for a running chat and “Incident response” for an unread chat.
- **When** The user searches the workspace.
- **Then** The “Deployment notes” result shows “Running” and the “Incident response” result shows “Unread”.

## sidebar-workspace-003

Original test `Filter workspace search to chats and navigate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L157).

- **Given** Workspace search returns “Deployment notes” and “Incident response” for “deploy”.
- **When** The user filters to Chats and selects “Deployment notes”.
- **Then** Only “Deployment notes” remains in the results, the app navigates to that chat, and the search dialog closes.

## sidebar-workspace-004

Original test `Show useful search-result ages and an illustrated empty state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L177).

- **Given** The search results include chats last active 5 minutes, 3 hours, 2 days, and 60 days ago.
- **When** The user opens workspace search and then searches for text with no matches.
- **Then** The first three chats show “5 minutes ago”, “3 hours ago”, and “2 days ago”; the 60-day-old chat shows a calendar date rather than an “ago” phrase. The empty state says “No results found”, displays an illustration, and omits the chats.

## sidebar-workspace-005

Original test `Toggle unread chats by reselecting an unread pinned agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L256).

- **Given** The user has pinned Research Agent and Support Agent, and the chat list is filtered to unread chats.
- **When** The user selects Support Agent, selects it again, then selects it a third time.
- **Then** The first selection navigates to Support Agent’s chat and shows both its unread and read chats. The second selection stays on that route without navigating and shows only its unread chat; the third stays on the same route without navigating and restores both chats.

## sidebar-workspace-006

Original test `Use context actions on pinned agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx#L341).

- **Given** Research Agent and Support Agent are pinned.
- **When** The user opens Research Agent’s context menu and unpins it, then opens Support Agent’s context menu with a touch gesture, dismisses it with Escape, and selects Support Agent.
- **Then** Research Agent is removed from the pinned list. The touch-opened menu is dismissed, and selecting Support Agent navigates to its chat.
