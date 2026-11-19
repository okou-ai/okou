# Connectors mcp expected failures

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-mcp-expected-failures.test.tsx](connectors-mcp-expected-failures.test.tsx).

## connectors-mcp-expected-failures-001

Original test `Keep MCP failure feedback and retry available for invalid discovery metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-mcp-expected-failures.test.tsx#L53).

- **Given** An admin has an automatic-OAuth MCP connector and OAuth discovery returns HTTP 400 with the recognized invalid-discovery code.
- **When** The admin tries to connect to Acme MCP.
- **Then** The user sees the discovery-metadata error explaining that server metadata is incomplete or inconsistent and suggesting the server administrator fix or check it. The popup closes, retry remains enabled, the card says “No accounts,” and no exception is reported.

## connectors-mcp-expected-failures-002

Original test `Keep MCP failure feedback and retry available for temporary provider unavailability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-mcp-expected-failures.test.tsx#L53).

- **Given** An admin has an automatic-OAuth MCP connector and OAuth discovery returns HTTP 502 with the recognized provider-unavailable code.
- **When** The admin tries to connect to Acme MCP.
- **Then** The user sees the message that the provider is temporarily unavailable or rate-limited and should be checked. The popup closes, retry remains enabled, the card says “No accounts,” and no exception is reported.

## connectors-mcp-expected-failures-003

Original test `Keep MCP failure feedback and retry available for an unknown setup failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-mcp-expected-failures.test.tsx#L53).

- **Given** An admin has an automatic-OAuth MCP connector and OAuth setup returns HTTP 400 with an unknown error code.
- **When** The admin tries to connect to Acme MCP.
- **Then** The user sees “MCP setup failed.” The popup closes, retry remains enabled, the card says “No accounts,” and an exception is reported with the returned code and status.

## connectors-mcp-expected-failures-004

Original test `Keep MCP failure feedback and retry available for an internal failure with a recognized c…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-mcp-expected-failures.test.tsx#L53).

- **Given** An admin has an automatic-OAuth MCP connector and OAuth setup returns HTTP 500 with the recognized invalid-discovery code.
- **When** The admin tries to connect to Acme MCP.
- **Then** The user sees the discovery-metadata error explaining that server metadata is incomplete or inconsistent and suggesting the server administrator fix or check it. The popup closes, retry remains enabled, the card says “No accounts,” and an exception is reported with the code and status.
