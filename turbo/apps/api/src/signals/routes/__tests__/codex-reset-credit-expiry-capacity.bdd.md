# codex-reset-credit-expiry-capacity

## codex-reset-credit-expiry-capacity-001

- Vitest: "Codex expiry cache capacity > evicts old identity entries at bounded capacity"
- Mode: run
- Given: An authenticated Codex account owner has an expiry returned by the provider. Repeating the account listing has reused that value. The provider can hold usage responses for 257 other account identities.
- When: While those organization connection requests are in flight, the provider changes the original expiry and the original owner lists accounts again. The pressure requests are then cancelled.
- Then: The first two lists show the initial expiry without an additional provider details call for the second. The later list shows the new expiry after exactly one details request for the original account. The pending connection attempts reject with the cancellation reason.
