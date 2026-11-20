# Workspace agent search

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [workspace-agent-search.test.tsx](workspace-agent-search.test.tsx).

## workspace-agent-search-001

Original test `Find workspace agents by name with case and whitespace normalization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workspace-agent-search.test.tsx#L78).

- **Given** The user is on a workspace chat with agents named “Research Agent” and “Support Agent.”
- **When** They search for `  REseaRCH  ` and select the Agents filter twice.
- **Then** The search finds exactly one result, “Research Agent,” and does not show “Support Agent.” The query remains unchanged, and Agents remains selected.

## workspace-agent-search-002

Original test `Navigate workspace search filters without changing the query or clearing selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workspace-agent-search.test.tsx#L109).

- **Given** The user is on a workspace chat and opens workspace search, then enters “Research.”
- **When** They navigate the filter options with the keyboard and activate each filter, using Space or Enter.
- **Then** The filters are All, Chats, Messages, Agents, Workflows, and Artifacts. All starts selected; activating each other filter selects it without changing the query. Only Agents shows one result; the other filters show zero. Escape closes search and returns focus to its trigger.
- **Upstream change** `4e5707de` (#49556) removes agent results and the Agents filter from workspace search and moves this upstream test to `workspace-search-filters.test.tsx`, where it searches from `/` for a chat titled Research notes; the upstream test is now `Navigate workspace search filters without changing the query or clearing selection` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/workspace-search-filters.test.tsx#L17)). Rebuild this scenario at `/` with a matching chat: the filters are All, Chats, Messages, Workflows, and Artifacts; only All and Chats show one result, and the rest show zero.

## workspace-agent-search-003

Original test `Selecting a workspace agent search result opens its chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workspace-agent-search.test.tsx#L178).

- **Given** The user is on a workspace chat and opens workspace search.
- **When** They search for “Support” and select “Support Agent.”
- **Then** The app opens that agent’s chat, displays “Chats with Support Agent,” and closes search.
- **Upstream change** `4e5707de` (#49556) removes agent results from workspace search and per-agent chat pages, and deletes this upstream test file. Retire this scenario.
