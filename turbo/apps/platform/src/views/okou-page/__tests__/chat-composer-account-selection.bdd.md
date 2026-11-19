# Chat composer account selection

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-account-selection.test.tsx](chat-composer-account-selection.test.tsx).

## chat-composer-account-selection-001

Original test `pagination results keep the selected account once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L103).

- **Given** A chat has Work as the default and Personal selected, with more accounts available through pagination.
- **When** The user loads more accounts.
- **Then** Personal remains selected exactly once, Client appears exactly once, and no thread-selection update is made.

## chat-composer-account-selection-002

Original test `remote search results keep the selected account once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L103).

- **Given** A chat has Work as the default and Personal selected, with more accounts available through pagination and remote search.
- **When** The user loads more accounts, searches for “remote,” and selects Research from the search results.
- **Then** Personal remains selected exactly once after loading more, and Client is absent from the remote search results. Selecting Research closes the chooser, returns focus to its trigger, and updates the chat’s selected account to Research.

## chat-composer-account-selection-003

Original test `Unavailable selected accounts retain their identity and fallback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L185).

- **Given** Personal is selected for the chat but requires reconnection; Work is the default and Client also requires reconnection.
- **When** The user opens the account chooser.
- **Then** Personal remains selected and is shown as falling back to Work. The default option is not selected, Client is marked as requiring reconnection, and no account selection is updated or cleared.

## chat-composer-account-selection-004

Original test `Open a single-account chooser and read fresh target accounts on reopen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L213).

- **Given** A chat has one Work account available for its connector.
- **When** The user opens the account chooser, closes it, the account’s display name changes to Renamed account, and the user reopens the chooser.
- **Then** The chooser initially shows Work and closes with focus returned to its trigger. On reopening, it shows Renamed account and no longer shows Work.
