# Credential Trust Boundary

These rules apply when credentials cross API, Runner, host MITM and sandbox
boundaries. Classify a value by who can read it and what authority it grants,
not by its variable name or whether it is called a token.

## Trusted and Untrusted Components

The API, Runner host and host-side MITM are trusted platform components. The
entire sandbox is untrusted, including its Guest Agent, model/CLI processes,
shell commands, environment, configuration and readable files. Keeping a value
out of a CLI child environment does not make it host-only if it still reaches
another process inside the sandbox.

Treat every sandbox-visible value as available to sandbox code. Base64 encoding,
placing it in a private Guest file, and supplying it to a masking/redaction
payload do not change that boundary. A masking system is not an authorization
boundary; do not send a host-only secret into the sandbox merely to redact it.

## Which Values May Enter a Sandbox

| Value and authority                                                                                                           | Placement rule                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Short-lived API identity with explicit limited scopes, grants and resource ownership                                          | May be delivered directly when the sandbox needs that authority.           |
| Short-lived content-download or storage-upload URL limited to the authorized object and operation                             | May enter the sandbox under the existing bounded object-transfer contract. |
| Reusable provider/model/connector key, refresh token, platform service credential or Preview bypass secret                    | Keep outside the sandbox. Resolve and inject through a trusted component.  |
| Signing/encryption keys, authority to sign arbitrary identities or derive keys, or raw long-lived-secret resolver credentials | Keep outside the sandbox, even if this credential itself expires quickly.  |

A short lifetime alone is insufficient. A sandbox token must grant only the
operations intended for that identity; it must not provide an escape hatch to
obtain more powerful or longer-lived credentials. A Run claim binds identity
but does not replace endpoint-owned resource, account, permission, status or
finalization checks.

The existing `OKOU_TOKEN` and `sandboxToken`/`OKOU_API_TOKEN` are distinct
identities and may retain their direct Guest delivery, current grants and
expiry. Do not infer that they are interchangeable or that every endpoint
revokes them immediately when a Run ends. Preserve the authorization and
lifecycle checks owned by each endpoint. Guest possession of either identity
must not, by itself, authorize raw upstream-secret resolution.

Both application credential resolution and network-only admission require the
host-only firewall token. Every API-authored execution publication carries it.
Standalone Runner jobs can use routes that need no API resolver. Keep the host
token out of Guest environment/configuration, masking values and user-visible
diagnostic responses. Signed scopes and verified claims determine authority.
Changing a token prefix must not upgrade it.

## Credentials Outside the Sandbox

Trusted API/Runner/MITM components may hold plaintext credentials, including
long-lived ones. Do not add application-level startup encryption solely to
transfer values among these trusted components. A host-only credential does
not need a short lifetime or a reference format merely because Guest-visible
credentials require stricter limits.

Preserve HTTPS, existing persisted-credential encryption, permission checks
and log/diagnostic redaction. Trusting the host does not authorize exposing its
credentials through sandbox-readable files, API responses or diagnostics.
Likewise, this rule does not authorize unrelated migrations to plaintext
credential storage.

## HTTP Request Ownership and Startup Cost

Keep costly credential access, decryption, refresh and injection on the
authorized HTTP request path when needed. Trusted MITM may receive resolved
material and inject it into the admitted upstream request; the Guest receives
the authorized service result, not a raw-secret resolver response.

Validate the current source/account, permissions and Run authority, and retain
final admission after awaited work. Bind injection to the allowed destination,
method and path. Recheck authority when a request is retargeted, and do not
forward credentials through an unapproved redirect or changed origin.

Do not eagerly build and encrypt an execution-secret dictionary on the
api_to_spawn critical path. An encrypted empty map or a replacement encrypted
package still pays the startup cost. Already-available cheap host-only values
may stay plaintext; avoid a blanket placeholder conversion, extra database
receipt or startup lookup that has no concrete security or performance need.

Verify both the overall startup distribution and cold first-HTTP latency and
failures. Moving work out of startup is not, by itself, proof of an end-to-end
latency improvement.

## Cross-Version Changes

Use the owning [deployment compatibility](deployment-compatibility.md) and
[fallback removal](fallback.md) gates. Deploy compatible readers before
changing writers; retain only transition behavior needed by actual live
consumers. After outgoing requests and old Run/Runner finalization drain,
delete the obsolete reader, fallback, wire field and its compatibility tests.
Do not make a temporary Guest-identity fallback a permanent resolver protocol.
