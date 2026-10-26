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
