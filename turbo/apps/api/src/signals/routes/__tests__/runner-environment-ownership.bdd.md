# runner-environment-ownership

## runner-environment-ownership-001

- Vitest: "runner environment ownership > separates trusted platform environment from untrusted entries"
- Mode: run
- Given: A Pro user with a configured subscription model starts a chat Run, and an authorized Runner for the configured group is available.
- When: The Runner reports its heartbeat and obtains the Run execution input. The owner cancels the Run after inspection.
- Then: The trusted platform environment contains the issued token and the chat thread ID, and the token is listed among secret values. None of those platform keys or other reserved `OKOU_` keys appear in the Agent environment. The inspected Run context snapshot does not contain the raw token, and cancellation returns HTTP 200.
