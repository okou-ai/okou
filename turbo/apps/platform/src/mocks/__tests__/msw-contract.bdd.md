# Msw contract

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [msw-contract.test.ts](msw-contract.test.ts).

## msw-contract-001

Original test `Contract mocks dispatch methods and decode path, query, and JSON inputs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L64).

- **Given** Contract mocks are registered for a GET endpoint that reads an encoded path ID and integer query value, and a PATCH endpoint that reads a JSON title.
- **When** A client requests the encoded ID with limit 2, sends a PATCH with title “Updated title,” then replaces the GET mock and repeats the request.
- **Then** Both methods return status 200; the path ID is decoded as “entry one,” the query value is 2, and the PATCH response includes the submitted title. The replacement GET mock returns limit 3.

## msw-contract-002

Original test `Contract mocks can inject undeclared failures without weakening declared bodies`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L101). · **intent review**

- **Given** A GET contract declares a successful response body with an ID and numeric limit, and its mock responds with an undeclared status 500.
- **When** A client requests the endpoint.
- **Then** The response has status 500 and the error body is preserved as {"error":{"message":"Upstream unavailable"}}. The declared 200 response body remains specifically typed, while the 500 body accepts an unknown shape.

## msw-contract-003

Original test `Nonmatching contract mocks do not duplicate cookies on the matched request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L119). · **intent review**

- **Given** The browser has the cookie “browser-preference=compact.” A cookie endpoint mock is registered alongside mocks for different paths and methods.
- **When** The client requests the cookie endpoint with a route-like string only in the query and includes credentials.
- **Then** The matching request returns status 200 and reports exactly “browser-preference=compact,” without duplicate cookies.

## msw-contract-004

Original test `Contract mocks preserve optional path matching for http://localhost/api/mock-optional`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L153). · **intent review**

- **Given** An optional-path GET mock accepts a missing ID.
- **When** The client requests http://localhost/api/mock-optional.
- **Then** The response has status 200 and a null ID.

## msw-contract-005

Original test `Contract mocks preserve optional path matching for http://localhost/api/mock-optional/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L153). · **intent review**

- **Given** An optional-path GET mock accepts a missing ID.
- **When** The client requests http://localhost/api/mock-optional/.
- **Then** The response has status 200 and a null ID.

## msw-contract-006

Original test `Contract mocks preserve optional path matching for http://localhost/API/MOCK-OPTIONAL/entr…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L153). · **intent review**

- **Given** An optional-path GET mock accepts an ID.
- **When** The client requests http://localhost/API/MOCK-OPTIONAL/entry%20one/.
- **Then** The response has status 200 and the decoded ID “entry one,” despite the uppercase path and trailing slash.

## msw-contract-007

Original test `Contract mocks preserve optional path matching for https://api.preview.test/gateway/api/mo…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L153). · **intent review**

- **Given** An optional-path GET mock accepts an ID on a configured route.
- **When** The client requests https://api.preview.test/gateway/api/mock-optional/entry%20one.
- **Then** The response has status 200 and the decoded ID “entry one,” despite the HTTPS origin and gateway prefix.

## msw-contract-008

Original test `Thread detail mocks leave static siblings to their own handlers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L166). · **intent review**

- **Given** Separate mocks are registered for chat-thread snapshots, events, and thread details.
- **When** The client requests the snapshot path, the events path, and then the detail path for “thread-one.”
- **Then** The snapshot and events requests are handled by their own mocks and return their respective source values; the detail request returns ID “thread-one.”

## msw-contract-009

Original test `Account detail mocks leave static lists to their own handlers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/mocks/__tests__/msw-contract.test.ts#L185).

- **Given** A static handler serves the connector-account connections list, and a detail handler serves individual accounts.
- **When** The user requests the connections list with kind=builtin and connectorSlug=github, then requests account-one.
- **Then** The list response is {"source":"accounts"}, and the detail response is {"connectionId":"account-one"}.
