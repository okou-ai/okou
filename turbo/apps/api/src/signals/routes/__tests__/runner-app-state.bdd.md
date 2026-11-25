# runner-app-state

## runner-app-state-001

- Vitest: "requires official Runner authentication and a current direct command"
- Mode: run
- Given: A caller supplies Run and command identifiers that have no current direct grant.
- When: The caller checks the app-state command first with an invalid bearer and then as an officially authenticated Runner.
- Then: The invalid bearer is rejected with HTTP 401, and the authenticated request without a current grant returns HTTP 404.

## runner-app-state-002

- Vitest: "only the assigned Runner and claimed Mac can deliver an opted-in capture"
- Mode: run
- Given: A Run is bound to a Mac host supporting ordinary and direct app-state capture. The Run has an assigned Runner and heartbeat generation. Direct transfer is initially disabled and then enabled for the owner.
- When: The Run creates an ordinary command with direct transfer disabled, then requests an opted-in TextEdit capture. The assigned Runner checks it before and after the Mac claims it. The host completes the capture, then stops after another direct command is created.
- Then: The initial command has no direct-transfer result and can be claimed normally. The opted-in command reports direct capture. The assigned Runner sees the Mac ID with claimed false before claim and true afterward, while the wrong generation gets HTTP 404. The Mac receives the upload URL and token on claim even after opt-out, while the Run command read omits the upload fields. Completion returns the receipt without an object-store upload. Both completion and host stop retire their grants, with subsequent checks returning HTTP 404.
