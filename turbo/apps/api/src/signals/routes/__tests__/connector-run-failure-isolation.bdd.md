# connector-run-failure-isolation

## connector-run-failure-isolation-001

- Vitest: "connector failure isolation in dispatched Runs > keeps healthy connector and model access through completion after a malformed provider response"
- Mode: run
- Given: An authenticated Chat owner has connected Lark and Figma accounts and has a usable personal Claude model. Lark's token endpoint responds successfully at HTTP level but omits the issued credential.
- When: After the owner starts a run and a Runner receives execution referencing the exact Lark account, the Runner calls POST /api/webhooks/run/firewall/auth for Lark, Figma and the Claude model. The run completes and the owner starts another.
- Then: Lark authorization returns HTTP 502 TOKEN_REFRESH_FAILED with failure reason upstream_provider and lark as the affected connector. The Lark account remains listed. The same authorization endpoint returns HTTP 200 with the configured Figma header and the model's configured Authorization header. The owner reads the run as running, then completed after its completion callback. A subsequent run exposes Figma in execution, can be read as running and also completes.

## connector-run-failure-isolation-002

- Vitest: "connector failure isolation in dispatched Runs > keeps healthy connector and model access through completion after a deleted account"
- Mode: run
- Given: An authenticated Chat owner has connected Lark and Figma accounts and has a usable personal Claude model. The Runner obtains a run execution referencing the exact Lark account, and the owner deletes that account.
- When: The Runner calls POST /api/webhooks/run/firewall/auth for Lark, Figma and the Claude model. The run completes and the owner starts another.
- Then: Lark authorization returns HTTP 424 CONNECTOR_NOT_CONFIGURED. The same authorization endpoint returns HTTP 200 with the configured Figma header and the model's configured Authorization header. The owner reads the run as running, then completed after its completion callback. A subsequent run exposes Figma in execution, can be read as running and also completes.
