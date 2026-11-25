# run-model-invalidation

## run-model-invalidation-001

- Vitest: "personal subscription invalidation > publishes account changes only to the owner without account details"
- Mode: run
- Given: An authenticated organization administrator can connect a personal Claude Code OAuth account. The realtime provider can accept publications initially and later becomes unavailable.
- When: The caller connects the account, disconnects it while publication fails, then repeats the disconnect.
- Then: Connecting returns HTTP 201, publishes `runModelsChanged` with a null payload to the user channel, and does not open the organization channel. The first disconnect returns HTTP 204 despite the provider failure. The repeated disconnect returns HTTP 404.
