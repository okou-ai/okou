# connector-invalidation

## connector-invalidation-001

- Vitest: "a committed account deletion still notifies readers when provider revocation is cancelled"
- Mode: run
- Given: An authenticated owner has authorized a Calendly account through the provider callback. The delete request will be cancelled while the provider revoke request is in flight.
- When: The owner sends DELETE /api/connector-accounts/:connectionId for the Calendly account and later lists their Calendly connections.
- Then: The delete rejects with AbortError. The subsequent HTTP 200 account list is empty and the owner's realtime channel receives exactly one connector:changed event naming calendly.
