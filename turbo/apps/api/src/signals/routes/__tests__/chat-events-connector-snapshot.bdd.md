# chat-events-connector-snapshot

## chat-events-connector-snapshot-001

- Vitest: "accepted Connector preparation > retains custom permission refresh while the Run is active: active"
- Mode: run
- Given: An authenticated workspace owner has selected a custom connector carrying an allow for Slack chat writes that expires after one hour. Its Run is still active before expiry.
- When: A Runner claims the Run and synchronizes the custom connector during execution.
- Then: The initial dispatch allows `chat:write`. The sync target is available, still allows `chat:write`, and returns the exact expiry as its next sync time.

## chat-events-connector-snapshot-002

- Vitest: "accepted Connector preparation > retains custom permission refresh while the Run is active: expired"
- Mode: run
- Given: An authenticated workspace owner has selected a custom connector whose one-hour allow for Slack chat writes expires while its Run is active.
- When: After a dispatch with the temporary allowance, the Runner synchronizes the connector at expiry.
- Then: The target remains available. The refreshed policy removes `chat:write` from allow and places it in deny without a next sync time.

## chat-events-connector-snapshot-003

- Vitest: "accepted Connector preparation > retains the first Thread account choice while input is prepared"
- Mode: run
- Given: A workspace member owns two Runtime accounts and has chosen the first for a thread. An attachment's metadata response is delayed.
- When: The member sends a prompt with the attachment, switches the thread to the second account while the request is preparing, and then submits a later prompt.
- Then: The first dispatch still refers to the original account and excludes the raw credential. The later dispatch refers to the newly selected account.

## chat-events-connector-snapshot-004

- Vitest: "accepted Connector preparation > retains coherent custom configuration and Skill bytes through reconnect"
- Mode: run
- Given: An authenticated workspace owner has a custom connector with a network prefix and Skill content. An attachment's metadata response is delayed.
- When: While a send is awaiting the attachment response, the owner changes the connector prefix and Skill content and reconnects the account. They start another send after the initial Run.
- Then: The first dispatch keeps the original prefix, account source and original Skill bytes. The next dispatch uses the updated prefix, and the changed Skill bundle has a different digest and contains the new text.

## chat-events-connector-snapshot-005

- Vitest: "accepted Connector preparation > retains coherent custom configuration and Skill bytes through deletion"
- Mode: run
- Given: An authenticated workspace owner has a custom connector with a network prefix and Skill content. An attachment's metadata response is delayed.
- When: While a send is awaiting the attachment response, the owner deletes the connector. They start another send after the initial Run.
- Then: The first dispatch keeps the original prefix, connector target, account source and original Skill bytes. The next dispatch contains neither that connector target nor the corresponding Skill mount.
