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

## Google authentication on Workers

Vercel uses its request OIDC identity. Workers use a Cloudflare `GCP_MTLS`
certificate binding to exchange an X.509 identity at Google STS, then impersonate
the configured service account for a short-lived access token. Keep the private
key in Cloudflare's mTLS certificate store; runtime configuration contains only
the public certificate chain. Neither runtime needs a Google service-account
private key.

Before deploying a Worker with Google operations enabled, provision a separate
certificate, privately controlled CA, X.509 workload identity pool/provider and
exact-subject service-account authorization for each of preview, staging and
production. Do not share the Data Router's certificate identity or grant a pool
wildcard. Record expiry, back up private material in the target's 1Password
vault, and rotate with an overlap before expiry.

The preview deployment script accepts these target-specific values:

| Process variable                      | Content                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GCP_MTLS_CERTIFICATE_ID`             | Cloudflare uploaded mTLS certificate ID                                                                              |
| `GCP_MTLS_CERTIFICATE_CHAIN`          | JSON array of base64 DER certificates, leaf first                                                                    |
| `GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER` | X.509 provider resource path: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |

CI selects repository variables named `CF_API_GCP_MTLS_<field>_PREVIEW` for PRs
and `CF_API_GCP_MTLS_<field>_STAGING` for staging, where `<field>` is
`CERTIFICATE_ID`, `CERTIFICATE_CHAIN`, or `WORKLOAD_IDENTITY_PROVIDER`. Selection
has no fallback between targets. The existing `GCP_LLM_PROJECT_ID` and
`GCP_LLM_SERVICE_ACCOUNT_EMAIL` still select the Google project and service
account. Deployment replaces `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` only in the
Worker's packed runtime configuration and adds `GCP_MTLS_CERTIFICATE_CHAIN`; the
shared Vercel environment retains its OIDC provider. Incomplete certificate
configuration fails before a build or resource mutation.

This does not add a production Worker deployment. Its eventual deployer must
supply the same binding/configuration contract from a separate production
identity and authorize its exact subject on the production service account.
