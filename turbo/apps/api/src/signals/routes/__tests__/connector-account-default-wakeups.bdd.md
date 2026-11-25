# connector-account-default-wakeups

## connector-account-default-wakeups-001

- Vitest: "default connector account runtime wakeups > notifies only the account owner's running Run and excludes other owners and cancellation"
- Mode: run
- Given: An authenticated Team workspace account owner has two OpenAI accounts with the first as default and a running run. A teammate in the same workspace has a separate running run.
- When: The teammate attempts to change the owner's default and the owner attempts an unknown account ID. The owner then sends POST /api/connector-accounts/:connectionId/default for the second account, switches back after obtaining execution, cancels the run, and switches again.
- Then: The two unauthorized or unknown changes return HTTP 404 with no realtime batch and the first default remains. The owner's valid changes return HTTP 200 and update both default flags on account-list readback. Each switch while the owner's run is active sends exactly one connector-runtime-sync message with that run ID and OpenAI target to the owner's Runner group. After cancellation the change still succeeds with no wakeup and the teammate's run remains running.

## connector-account-default-wakeups-002

- Vitest: "default connector account runtime wakeups > keeps a custom default committed after notification failure and confines recovery to its workspace"
- Mode: run
- Given: An authenticated Chat owner has two configured custom HTTP connector accounts and a running run. A different workspace also has an active run. The realtime transport will reject the first publication.
- When: The owner sends POST /api/connector-accounts/:connectionId/default to select the second account and later sends another request to restore the first.
- Then: Both changes return HTTP 200 and each new default is visible in the custom accounts list. Each change attempts one connector-runtime-sync publication to the owner's Runner group with the owner's run ID and custom connector target. The first publication failure leaves the account change committed, and the later publication is scoped to the same owner's run.
