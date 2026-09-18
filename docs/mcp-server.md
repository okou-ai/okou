# External MCP server

The Hono API exposes a Streamable HTTP resource server at `/mcp`. It uses the
official MCP SDK and serves `get_indicators`, a read-only tool backed by the same
user/organization projection as the app's indicators endpoint. This is the first
slice of #34890, tracked by #34931. Thread history and mutations are separate slices.

`get_indicators` accepts an empty object and returns `agents` and `threads` maps.
Each entry is `active` or `unread`; absent entries have no indicator. These sparse
maps are not a list of all runs or an authoritative terminal run status. Results
include both structured content and a JSON text representation.
Active threads are complete; unread threads use the existing projection's latest
50 terminal markers from the last seven days. An unread agent indicator takes
precedence when another thread of that agent is active.

## Configuration and authorization

The `McpServer` feature switch defaults to off. Standard per-user/per-organization
overrides apply to the verified OAuth principal. Metadata is public; discovery and
tool calls require authorization and the feature override.

Configure these optional API environment variables before enabling an account:

| Variable           | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `MCP_RESOURCE_URL` | Exact HTTPS resource identifier ending in `/mcp`, including the deployment's real origin. |
| `MCP_OAUTH_ISSUER` | Exact trusted HTTPS Clerk OAuth issuer for that deployment.                               |

Missing resource/issuer configuration makes the MCP surface return 503 and does
not change first-party API authentication. Resource and issuer are never derived
from the request Host or an unverified token. Configure the deployed environment
through its normal deployment process; this code does not configure Clerk or
activate production.

The shared `.github/actions/web-api-env` deployment action injects these values
only into the API service. It builds `MCP_RESOURCE_URL` from the trusted
`api-backend-url` deployment input (the API origin, with an optional trailing
slash), followed by `/mcp`. Preview workflows supply each PR/staging API alias;
production supplies its configured API origin. Do not set a shared
`MCP_RESOURCE_URL` repository variable: it is not read, and each deployment must
use its own audience. API deployments require `api-backend-url`; if it is empty,
the action fails before creating an environment file. Web deployments may omit it.

Set the non-secret `MCP_OAUTH_ISSUER` GitHub repository variable to the test Clerk
instance's exact OAuth issuer. Override the same variable in the `production`
GitHub Environment with `https://clerk.okou.ai`, matching that environment's
Clerk credentials. Without an issuer, MCP returns 503 while the existing API
remains available.
These deployment variables do not enable the `McpServer` feature switch or
configure OAuth settings in either Clerk instance.

The resource server accepts only `Authorization: Bearer` OAuth access JWTs signed
by the configured Clerk instance. It requires an access-token header type
(`at+jwt` or `application/at+jwt`), exact issuer, the configured resource in `aud`,
unexpired `exp`, a user `sub`, selected `org_id`, `client_id`, and scopes from
`scope` or `scp`. If both scope claims are present they must agree. Session/ID
tokens, API/PAT tokens, machine subjects and opaque access tokens are not accepted.
The existing first-party token parser is unchanged.

The signed organization is the organization selected at consent. Every request
checks current membership using the existing membership service; positive cached
membership can remain valid for up to 60 seconds. A removed member is rejected;
a Clerk/key-service outage returns 503 rather than pretending the user is invalid.
Local JWT verification does not provide immediate provider token revocation:
an already issued token can remain usable until expiry, subject to membership and
feature checks. Short token lifetimes and the provider's actual revoke/refresh
behavior must be verified before rollout.

Initial and invalid-token `401` challenges request the complete default grant:

```text
openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access
```

Protected-resource metadata advertises the same nine scopes for clients that
select scopes through discovery. The defaults include identity information,
organization selection, the planned chat operations and refresh-token access, so
clients can request them in one consent flow without relying on incremental
authorization support.

Only `user:org:read` and `okou:chat:read` are required for the current endpoint and
`get_indicators`. Tokens with just these two scopes remain valid. A
`403 insufficient_scope` challenge names those required scopes. Each future tool
must enforce its own permissions; listing a scope does not
implement or authorize that operation. A tool argument cannot select or override
the organization. Existing grants do not automatically gain scopes; clients must
reauthorize to obtain additional permissions.

## Provider setup gate

Clerk is the authorization server; this API does not implement authorization,
token exchange, client registration or a consent UI. Before hosted acceptance:

1. In **OAuth applications → Settings**, enable **Publish CIMD support**, disable
   **Publish DCR support**, and select **Any compatible CIMD client**. Use JWT
   access tokens with **Include Audience**, require PKCE S256, and configure the
   supported scopes. Under **Client onboarding → Default scopes for dynamic
   clients**, set the same nine default scopes listed above. Clerk applies these
   defaults when a client omits `scope`; it does not expand an explicitly requested
   scope set. Creating or advertising scopes alone does not set these defaults.
   Compatible clients identify themselves through their HTTPS metadata document;
   no manual OAuth application or callback registration is
   required for each client. Verify that issuer metadata advertises CIMD and
   omits the DCR registration endpoint.
2. Configure organization selection during consent and the provider's organization
   permission (`user:org:read` where required). Obtain a real grant and establish
   that its signed access JWT includes the selected `org_id`, resource `aud`,
   `client_id` and intended custom scopes. An ordinary Clerk session JWT is not
   a substitute. If the provider cannot issue this contract, keep the feature off
   and resolve the authorization design before rollout.
3. Verify reauthorization into a different organization, token refresh, expiry,
   revoked grants and membership removal using that actual application.

Synthetic signed-token tests prove verification and isolation, not provider-side
consent or token issuance. Do not treat their success as completing this gate.

### Login and consent return

Keep Clerk's default Account Portal OAuth consent page. The App derives its
trusted Account Portal origin from the active Clerk publishable key and preserves
only that instance's HTTPS `/oauth-consent` return. This origin is shared with
Clerk's redirect validation; client callback URLs are not App login destinations.
The original consent query survives login, registration and switching between
them. A fully active session on a root auth route continues through
`clerk.redirectWithAuth()`, which carries development browser authentication
across origins. Pending session tasks, factor routes and explicit authentication
or account-selection intents remain with Clerk's forms. Consent and organization
selection still happen on Clerk's hosted page.

In the development Clerk Dashboard **Paths**, point sign-in and sign-up to the
local App (`https://app.vm7.ai:8443/sign-in` and
`https://app.vm7.ai:8443/sign-up`). The Marketing service does not host these
pages. Keep OAuth consent on the default Account Portal. Production uses
`https://app.okou.ai/sign-in`, `https://app.okou.ai/sign-up` and
`https://accounts.okou.ai/oauth-consent`. No additional App environment variable
is needed for the default hosted consent page.

## HTTP behavior

Clients start with `/.well-known/oauth-protected-resource/mcp`, or follow the
`resource_metadata` URL in a 401 `WWW-Authenticate: Bearer` challenge. The metadata
publishes the resource and authorization server. A valid token without the read
scope receives 403 `insufficient_scope`; a disabled account receives 403
`access_denied`. Authenticated responses use `Cache-Control: no-store`.

The SDK handles JSON-RPC discovery (`tools/list`), invocation (`tools/call`),
initialization and protocol errors. 2025 protocol traffic uses stateless Streamable
HTTP with SSE responses. The 2026-07-28 protocol uses the SDK's envelope and
`MCP-Method`/`MCP-Name` headers with automatic JSON/SSE response selection. Clients
should use a conforming SDK instead of implementing these envelopes themselves.
No persistent MCP session, standalone event feed, subscription, or resumability
is offered; stateless GET/DELETE requests return 405. POST bodies are limited to
64 KiB. Transport/request cancellation stops request work and never cancels a
business run.

Browser Origins must exactly match the fixed allowlist in
[`mcp-server-config.ts`](../turbo/apps/api/src/lib/mcp-server-config.ts). The list
starts empty; add exact HTTPS origins in code when a browser client needs access.
There is no environment variable for this list. Unlisted Origins, including `null`
and empty values, are rejected before authentication, including preflight requests.
Native clients without an Origin work. For listed origins, preflight allows
bearer/protocol headers and responses expose the authentication
challenge and protocol headers. Cookie credentials are not used. Protected-resource
metadata supports public cross-origin discovery.

## Acceptance evidence

Automated route tests use real Hono routing, SDK transport, RSA signature checks,
the membership service, feature overrides and the indicators projection. Only
external provider/network boundaries are simulated. They cover both protocol
eras, complete response consumption, invalid grants, scope/membership isolation,
Origin checks and provider outages.

Before enabling broader access, record a generic MCP client/Inspector check
against a real hosted preview or staging endpoint, including complete JSON and
SSE response delivery. Then record basic OAuth, discovery and indicators results
for Claude, ChatGPT, Claude Code and Codex, with client version/account conditions.
Local HTTP tests do not establish hosted-client reachability. The four-client
matrix for the full tool set remains #34936; provider and first-tool acceptance
for #34931 remains open until supported by actual evidence.
