# runner-home-protocol-compatibility

## runner-home-protocol-compatibility-001

- Vitest: "canonical Runner protocol execution > rejects an incomplete whole-state heartbeat"
- Mode: run
- Intent: review
- Given: An officially authenticated Runner belongs to a configured Runner group and has a whole-state snapshot with sandbox and reuse-producer arrays.
- When: The Runner posts the snapshot to `POST /api/runners/heartbeat` without the required `heldHomeStates` array.
- Then: The API responds with HTTP 400.
