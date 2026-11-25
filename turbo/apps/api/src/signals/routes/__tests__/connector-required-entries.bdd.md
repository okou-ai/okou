# connector-required-entries

## connector-required-entries-001

- Vitest: "authorized connector admission > claims the exact normally connected account for an enabled connector"
- Mode: run
- Given: An authenticated Chat owner selects the Claude Fable model and connects an enabled OpenAI connector using its manual API-token grant.
- When: The owner sends a Chat run and the Runner obtains its execution.
- Then: The execution's OPENAI_TOKEN source metadata identifies the exact connected account ID.

## connector-required-entries-002

- Vitest: "authorized connector admission > lists the exact admitted manual MCP account for a dispatched Run"
- Mode: run
- Given: An authenticated Chat owner selects the Claude Fable model and connects the built-in manual MCP connector using its API-token grant.
- When: The owner starts a Chat run. After the Runner gets execution, the caller sends GET /api/mcp-connectors with that run's execution-provided Okou token.
- Then: Discovery returns HTTP 200 and includes the built-in manual MCP target with the exact connected account ID.
