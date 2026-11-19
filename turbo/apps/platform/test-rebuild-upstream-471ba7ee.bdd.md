# Upstream additions through 471ba7ee

## upstream-471ba7ee-sidebar-chat-history-1267-01

The Okou rail entry opens My Okou's chat page at /. [Registration](https://github.com/okou-ai/okou/blob/471ba7ee/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-chat-history.test.tsx#L1267).

- **Given** My Okou and the Okou rail entry are enabled, and the user is viewing an existing conversation.
- **When** The user selects the Okou entry in the navigation rail.
- **Then** The rail shows an Okou link to `/` and no separate Chat entry. Selecting it opens `/`, where New chat is the current page in the sidebar.
- **Disposition** retain; rebuild with `sidebar-chat-history`.
