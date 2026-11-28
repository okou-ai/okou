# run-lifecycle-automatic.bdd

## run-lifecycle-automatic.bdd-001

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits the exact builtin Automatic none account and injects auth outside the sandbox"
- Mode: run
- Given: A Pro member connects an Automatic built-in MCP account using no provider authentication. The provider advertises the selected transport and authentication.
- When: The member creates a Run, the assigned Runner reads dispatch, the Run lists connectors, and both the member and Run check the endpoint. The network boundary resolves authentication for the bound account.
- Then: Dispatch and discovery keep the exact connection and endpoint and the system prompt lists the connector. The execution carries neither provider tokens nor the token environment variable. Both checks resolve and indicate no credential resolution. The boundary returns no headers. Cancelling the Run returns HTTP 200.

## run-lifecycle-automatic.bdd-002

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits the exact builtin Automatic oauth account and injects auth outside the sandbox"
- Mode: run
- Given: A Pro member connects an Automatic built-in MCP account using OAuth. The provider advertises the selected transport and authentication.
- When: The member creates a Run, the assigned Runner reads dispatch, the Run lists connectors, and both the member and Run check the endpoint. The network boundary resolves authentication for the bound account. The account then reconnects with no auth and the Run syncs and repeats its lookup.
- Then: Dispatch and discovery keep the exact connection and endpoint and the system prompt lists the connector. The execution carries neither provider tokens nor the token environment variable. Both checks resolve and indicate network-boundary authentication. The boundary returns the bearer header. Reconnect preserves the account ID and sync returns available with no firewall field. The old auth binding fails with HTTP 424 and `CONNECTOR_NOT_CONFIGURED`, and connector check still resolves the network-boundary route. Cancelling the Run returns HTTP 200.

## run-lifecycle-automatic.bdd-003

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits the exact builtin Automatic query account and injects auth outside the sandbox"
- Mode: run
- Given: A Pro member connects an Automatic built-in MCP account using an endpoint with query routing and OAuth. The provider advertises the selected transport and authentication.
- When: The member creates a Run, the assigned Runner reads dispatch, the Run lists connectors, and both the member and Run check the endpoint. The network boundary resolves authentication for the bound account. The account then reconnects with no auth and the Run syncs and repeats its lookup.
- Then: Dispatch and discovery keep the exact connection and endpoint and the system prompt lists the connector. The execution carries neither provider tokens nor the token environment variable. Both checks resolve and indicate network-boundary authentication. The boundary returns the bearer header. Reconnect preserves the account ID and sync returns available with no firewall field. The old auth binding fails with HTTP 424 and `CONNECTOR_NOT_CONFIGURED`, and connector check still resolves the network-boundary route. Cancelling the Run returns HTTP 200.
