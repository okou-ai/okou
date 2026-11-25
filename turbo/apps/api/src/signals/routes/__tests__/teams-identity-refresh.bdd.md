# teams-identity-refresh

## teams-identity-refresh-001

- Vitest: "Teams identity refresh through signed personal messages > replaces a connected non-null Teams ID when the same AAD sends a new ID"
- Mode: run
- Given: A Teams installation already has a connected workspace member with a known tenant, Teams user ID, and Microsoft Entra object ID. Teams' member lookup can attest that a replacement Teams user ID belongs to the same tenant and object ID.
- When: Teams sends a signed personal `/connect` message from the original identity, then from the attested replacement identity and repeats it. Finally the old Teams ID sends another message without an object ID.
- Then: The original request and both requests from the replacement receive the bot's connected reply on the triggering activity. Only the obsolete identifier without the object ID receives an Adaptive Card with a `Connect` link to the Teams settings page, carrying its tenant and Teams user ID without the Entra object ID.
