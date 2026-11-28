# runners-personal-instructions

## runners-personal-instructions-001

- Vitest: "Captured personal Instructions in direct Runs > keeps published personal content and signed API mode after personal Instructions change"
- Mode: run
- Given: An authenticated member saves personal Instructions, admits a Run, and edits those Instructions before dispatch.
- When: The Runner reads the published bundle. The active Run token updates and reads the member’s Instructions, then retries the read after its Run is cancelled.
- Then: The bundle continues to contain the admission-time text. Both active calls return HTTP 200 and the read matches the update. Cancellation returns HTTP 200 and the later read returns HTTP 403.

## runners-personal-instructions-002

- Vitest: "Captured personal Instructions in direct Runs > mounts an empty Instructions file after the member clears it"
- Mode: run
- Given: A member saves and clears personal Instructions before creating a Run.
- When: The Runner reads the dispatched instructions bundle.
- Then: It contains only `instructions.md`, with zero bytes.

## runners-personal-instructions-003

- Vitest: "Captured personal Instructions in direct Runs > uses the default until the first save and isolates two members in the same workspace"
- Mode: run
- Given: The deployment publishes a default instructions bundle. Two members of one workspace have not yet submitted their own Instructions.
- When: The first member starts an initial Run and then both members save different Instructions and start their own Runs. The second member’s Run token reads the saved Instructions.
- Then: The initial execution uses the deployment default. Later bundles contain only the individual owners’ saved text. The second member’s read returns HTTP 200 with their own user ID and text.
