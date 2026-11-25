# runners-unavailable-execution

## runners-unavailable-execution-001

- Vitest: "Runner dispatch permissions > delivers authorized connector permissions to its bound process"
- Mode: run
- Given: A signed-in owner has connected Figma with a manually supplied token and has an assigned Runner for a Claude Fable Run.
- When: The Runner takes execution input, the owner reads Runner assignment, and the sandbox completes the Run.
- Then: Execution grants `file_content:read` with empty ask and deny lists and unknown-policy allow. The owner’s HTTP 200 Runner lookup agrees with dispatch identity and heartbeat generation. Readback shows completed.

## runners-unavailable-execution-002

- Vitest: "Runner dispatch permissions > releases cancelled execution before dispatching a later Run with retained permissions"
- Mode: run
- Given: A signed-in owner has connected Figma and started a Claude Fable Run in a thread.
- When: The owner cancels the Run, the sandbox reports terminal exit 137, and the owner launches another Run in the same thread.
- Then: Cancellation and terminal callback both return HTTP 200 and readback shows cancelled. The later Run is running and receives the retained Figma policy with `file_content:read`, empty ask and deny lists and unknown-policy allow.
