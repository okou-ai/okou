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

The Worker deployment script accepts these target-specific values:

| Process variable                      | Content                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GCP_MTLS_CERTIFICATE_ID`             | Cloudflare uploaded mTLS certificate ID                                                                              |
| `GCP_MTLS_CERTIFICATE_CHAIN`          | JSON array of base64 DER certificates, leaf first                                                                    |
| `GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER` | X.509 provider resource path: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |

CI selects variables named `CF_API_GCP_MTLS_<field>_PREVIEW` for PRs,
`CF_API_GCP_MTLS_<field>_STAGING` for staging, and
`CF_API_GCP_MTLS_<field>_PRODUCTION` for production, where `<field>` is
`CERTIFICATE_ID`, `CERTIFICATE_CHAIN`, or `WORKLOAD_IDENTITY_PROVIDER`. Selection
has no fallback between targets. The existing `GCP_LLM_PROJECT_ID` and
`GCP_LLM_SERVICE_ACCOUNT_EMAIL` still select the Google project and service
account. Deployment replaces `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` only in the
Worker's packed runtime configuration and adds `GCP_MTLS_CERTIFICATE_CHAIN`; the
shared Vercel environment retains its OIDC provider. Incomplete certificate
configuration fails before a build or resource mutation.

## Production Worker deployment

After the canonical Vercel API release succeeds, `release-please` deploys the
same `release_target` to `okou-api-production` on the account's `workers.dev`
subdomain. It reuses the resolved production runtime configuration and reads the
existing Neon `production` branch's direct connection for a separate Hyperdrive
with query caching disabled. The existing API release remains the only owner of
database migrations; the Worker deployer never creates, migrates, or seeds a
Neon branch.

Before the first deployment, configure all three
`CF_API_GCP_MTLS_<field>_PRODUCTION` variables in the repository or GitHub
`production` environment, using a separate production certificate/provider and
an exact-subject grant on the production service account. The existing
`CF_API_WORKER_DEPLOY_API_TOKEN` must permit Worker deployment, Hyperdrive
reconciliation, and use of that certificate in `CF_ACCOUNT_ID`. Certificate
provisioning, private-key backup, and rotation remain operator-owned.

Optional `CF_API_LOGS_DESTINATION_PRODUCTION` and
`CF_API_TRACES_DESTINATION_PRODUCTION` select preconfigured production OTLP
destinations. Development destination variables are not used. Native telemetry
replacement remains disabled, preserving the production application's existing
telemetry exports.

The new `workers.dev` origin is publicly reachable and uses normal production
route authentication, not the preview automation bypass. It accesses production
data. Custom routes and cron triggers remain empty; canonical API, OAuth,
webhook, and self-call URLs continue to use the existing production service.
This deployment does not switch `api.okou.ai` traffic or add a second cron owner.

Worker contract checks, deployment, and verification each use
`continue-on-error: true`. Failures appear as warnings and in the workflow
summary, while migrations and the canonical Vercel release remain required.
Verification reads `/health` and `/api/build-info` from the Worker and requires
the expected release SHA; it does not establish Google authentication or
business-path readiness. Perform an authorized production happy-path check
before routing clients to this origin.

The current production rollback workflow only rolls back the canonical API;
it does not update this auxiliary Worker. Include the Worker in the rollback
and request-drain plan before a traffic cutover.
