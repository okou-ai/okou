# Api client bootstrap

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [api-client-bootstrap.test.ts](api-client-bootstrap.test.ts).

## api-client-bootstrap-001

Original test `uses a matching bootstrap response once before falling back to the network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.test.ts#L11).

- **Given** A matching one-use bootstrap response and a different network response are available for a feature-switch request.
- **When** The client makes three successive requests, with the third carrying an abort signal.
- **Then** The first request returns the bootstrap response without obtaining a token or using the network; the next two return the network response, and the token provider is called once per network request with the corresponding signal.

## api-client-bootstrap-002

Original test `validates agent descriptor responses against the original contract`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.test.ts#L66).

- **Given** An agent descriptor endpoint first returns a valid agent and then an agent with an invalid visibility value.
- **When** The client requests the agent list for each response.
- **Then** It accepts the valid response and rejects the invalid response with a response-validation error.

## api-client-bootstrap-003

Original test `fails when a descriptor has no test response validator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.test.ts#L102). · **intent review**

- **Given** A client contract describes a GET endpoint with no response validator.
- **When** The client requests that endpoint and receives a response.
- **Then** The request rejects because the validator for GET /api/unmapped-descriptor is missing.
