```
pnpm install
pnpm --filter api dev
```

```
open http://localhost:3001
```

`GET /` returns the Hono greeting plus the built-in model names backed by
`built_in_model_keys`. It does not return vendors or API key values.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to
export Hono request spans and `pg` query spans.

## Outbound HTTP

Declare the responses a call site handles with the shared `accept` helper:

```ts
import { accept } from "@okouai/connectors/accept";

const response = await accept(fetch(url), [200, 404]);
if (response.status === 404) {
  return null;
}
return await response.json();
```

An undeclared status throws `HttpStatusError`; transport failures propagate
unchanged. Provider adapters may decode `HttpStatusError.response` when they
translate provider errors into an existing domain result. The helper does not
consume the body, retry, impose a deadline, or present an error to the user.

API work continues after the HTTP client disconnects. Do not forward the
incoming request's abort signal or add application-level HTTP timeouts. Internal
signals still own service shutdown, cache invalidation, streams, and cleanup.
Durable job leases and browser protocol deadlines belong to their own lifecycle.
Use fetch's default redirect handling unless a protocol requires reading the
redirect itself.
