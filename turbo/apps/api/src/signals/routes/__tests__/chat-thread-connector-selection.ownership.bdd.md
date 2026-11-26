# chat-thread-connector-selection.ownership

## chat-thread-connector-selection.ownership-001

- Vitest: "chat-thread connector account ownership > rejects foreign owners and mismatched authorized targets without replacing selections"
- Mode: run
- Given: An authenticated workspace member owns a Chat, a built-in OpenAI account and an account on a custom connector. Another member in that workspace and the same user in another workspace each have their own OpenAI account.
- When: The owner sets and reads both current thread connections, then tries foreign accounts and crosses built-in and custom targets. The other identities try to read and change thread settings. The owner then disables and restores each selected account, renames and deletes the OpenAI account, and deletes the custom connector.
- Then: The initial writes and reads return HTTP 200, with two selections and the matching account descriptions. Invalid account or target combinations return HTTP 400 `BAD_REQUEST` for current selection and HTTP 404 for overrides and leave settings unchanged. Foreign reads and account-access mutations are indistinguishable from a missing thread at HTTP 404, and a foreign current-selection update returns the same HTTP 400 as for a missing thread. Disabling removes that connection from the readback and clears its current ID, reselection fails while disabled, and removing the override restores it. Renaming updates the live description while preserving selection. Deleting each makes its selection and description disappear until both lists are empty.
