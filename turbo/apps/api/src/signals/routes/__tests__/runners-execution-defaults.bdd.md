# runners-execution-defaults

## runners-execution-defaults-001

- Vitest: "Direct Run launch defaults > pins the dispatch timezone and retains restrictions and identity with compact context"
- Mode: run
- Given: An authenticated user starts a direct Run while their timezone is America/Los_Angeles, then changes the preference to Asia/Shanghai before dispatch.
- When: The assigned Runner reads the first execution, the user cancels it and starts a second Run, and the Runner reads the second execution.
- Then: The first execution retains America/Los_Angeles in its timezone field and system prompt, disallows the tested scheduling tools and includes the configured App URL, thread identity and token in the platform environment. Cancellation returns HTTP 200. The second execution uses Asia/Shanghai in both the timezone field and system prompt.
