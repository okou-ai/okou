# VNC configuration and authority

VNC is an independent remote-access capability alongside SSH. The
`VncAccess` (`vncAccess`) feature switch is disabled by default, including for
staff. Explicit owner/Agent grants, metadata inventory and private Runner
authority are described in [Runner VNC authority](runner-vnc-authority.md).
Runner sockets and operations remain #34780; UI and CLI remain #34782/#34781.

## Owner API

Organization session authentication and a fresh Clerk membership check
are required for every request. The session's cached organization role alone is
insufficient. A disabled feature or absent membership returns an unavailable
response. Metadata responses use `Cache-Control: no-store`.

| Resource                             | Operations                                      |
| ------------------------------------ | ----------------------------------------------- |
| `/api/vnc/credentials`               | GET metadata; POST with a client-generated UUID |
| `/api/vnc/credentials/:credentialId` | PATCH and DELETE with `expectedRevision`        |
| `/api/vnc/connections`               | GET metadata; POST with a client-generated UUID |
| `/api/vnc/connections/:connectionId` | PATCH and DELETE with `expectedGeneration`      |
| `/api/vnc/connections/summary`       | GET `{ configuredCount }`                       |

A credential contains a display name and typed `authentication`. The currently
supported variant is `{ method: "vnc_password", password }`, with a password of
**1–8 printable ASCII bytes**. This limit belongs to classic VNC password
authentication, not every future credential method. Spaces are preserved and
overlength or non-ASCII input is rejected rather than truncated. Metadata exposes
`authMethod`, never the authentication payload. Credentials can be shared by
multiple saved connections belonging to the same user and organization.

Hosts contain a canonical DNS name or IP address, a port (default 5900), a
credential selection and explicit `security`. The currently supported profile is
`{ type: "x509_vnc", trust }`; its trust is either `{ mode: "system" }` or
`{ mode: "custom_ca", caBundle: "..." }`.
A custom bundle is at most 64 KiB and contains at most eight public CA
certificates. Private keys, non-CA certificates, malformed material and insecure
trust modes are rejected. Saving configuration does not dial or verify the host.

Connection creation accepts either `credential: { id }` or
`credential: { create: { name, authentication } }`. Inline credential and host
creation commit atomically. Each saved connection has its own UUID; multiple
connections can share the same canonical host and port, including the same
credential. This permits independent login and security configurations, matching
SSH. Updates and deletion address one saved UUID rather than every matching
endpoint. Failed writes and creation retries cannot leave an orphaned inline
credential.

Like SSH configuration, repeating the UUID of an existing resource belonging to
the current owner returns 204 without changing metadata or secrets.
A UUID occupied by another owner returns an opaque conflict.
Deletion physically removes the row, so a subsequent create with that UUID is a
new resource starting at version 1. Clients should use a new UUID for each new
resource and stop retrying its creation after deletion. Updates and deletes reject stale versions;
the caller must refresh metadata before deciding whether to resubmit. Credential
authentication changes advance every referencing connection's generation. Referenced credentials cannot be deleted
until their hosts are rebound or deleted. Deleting a host retains its reusable
credential.

## Owner setup in the app

With `vncAccess` enabled, open **Connectors → Remote access → VNC**.
The independent VNC page at `/connectors/vnc` manages hosts and reusable
credentials. Add a host's hostname or IP address and port (default 5900), then
select a saved credential or create one. The initial supported profile is
VeNCrypt X509Vnc: certificate-verified TLS plus a classic VNC password.
Passwords must contain 1–8 printable ASCII characters; spaces are significant.
The app does not offer unsupported authentication profiles or an insecure
certificate bypass.

Choose system certificate authorities or paste the public CA certificates
needed to verify the server. Custom trust accepts at most eight CA certificates
and 64 KiB; do not paste private keys or leaf server certificates. The server
certificate must identify the configured hostname or IP address. Saving a host
records configuration; it does not test reachability or authenticate a session.

Adding the first VNC host automatically grants access to every Agent currently
visible to the owner, including another workspace member's public Agents. The
host and grants commit atomically. Adding later hosts preserves manual revocations
and does not grant Agents created afterward. After every host is deleted, adding
one again repeats this onboarding default for the Agents visible at that time.

Manage VNC access explicitly using the card's Agent access control or the Agent's
authorization tab. This grant is independent of SSH and permits access to the
owner's current and future configured VNC hosts. Agents select shared or exclusive
mode when opening each session; the server decides admission and may override
the requested mode. The settings page adds no controller lock.

The Credentials tab shows which hosts use each credential. Renaming does not
rotate its password; explicitly replacing the password affects every bound
host. Saved passwords are never returned or prefilled. A referenced credential
cannot be deleted until its hosts are removed or reassigned. Deleting a host
retains its reusable credential.

Edits and deletes use the version reviewed when the dialog opened. If another
operation changes it, close the dialog and review the refreshed configuration
before retrying. After an uncertain save, the original form is locked: explicitly
retry the same request, or close and refresh to check whether it succeeded.
Closing, navigating away or changing owner discards unsaved passwords.
There is no VNC realtime subscription; revisit the page or use Refresh to
observe changes from another client.

Deploy the existing VNC APIs before this app UI. An unavailable/disabled API
shows an unavailable state; network and server failures remain retryable load
errors. The UI does not change the default-off switch or existing data.
Real Agent/server interoperability, two-client admission, mixed versions and
retained-data rollback are tracked separately in
[#35299](https://github.com/vm0-ai/okou/issues/35299); merging the UI is not
production activation evidence.

## Secret inventory

The only VNC encrypted field is
`vnc_credentials.encrypted_password`. It uses the existing stored-secret KMS
envelope. Passwords and ciphertext never appear in owner responses; current API
configuration paths do not decrypt them. The private Runner resolve endpoint
decrypts only after current authorization and profile validation. Public CA certificates are stored as public trust
configuration. The active KMS recovery verifier includes this field and accepts
retained snapshots that predate the VNC table. If the table exists, its exact
primary key and password column are required and every ciphertext is checked
without modification. The original rotation manifest and backfill remain
unchanged; a future rotation must include VNC in its current inventory.

## Membership and deletion lifecycle

The configuration tables are `vnc_credentials` and `vnc_connections`. Both use the
organization/user pair as their owner, matching SSH configuration. The
`agent_vnc_access` table stores explicit grants with the same composite
organization/user/Agent key as SSH. Current
membership authorizes access to that owner's configuration. If the user leaves
and rejoins before cleanup removes the configuration, it remains the same
owner's data and is accessible again. Each saved connection retains its own
identity across membership changes.

Mutation transactions use the existing B1 erasure admission, shared cleanup-scope
locks and an exclusive owner lock. Cleanup takes an exclusive scope lock and
deletes hosts before credentials. These locks serialize overlapping transactions
without retaining a VNC authority ledger or creation receipts. They do not cancel
a request that passed membership admission before cleanup and only enters its
write transaction afterward; such an in-flight request can still finish.

Current user, organization and member cleanup removes hosts before credentials,
and removes owner grants, including grants with no hosts.
Member cleanup removes the organization's configuration for that user. It follows
the existing organization/user cleanup path, including when a deletion event
arrives after the user has rejoined. Membership checks and KMS calls run outside
database locks.

## Authentication extension boundary

Credential methods describe the supplied authentication material; connection
security profiles describe the owner's selected wire authentication and server
trust policy. Only `vnc_password` with `x509_vnc` is accepted today. Unknown methods,
profiles and unsupported trust shapes are rejected, with no implicit default to
the current profile. Adding a runtime method must not silently broaden an
existing connection's saved policy.

Future username/password, credentialless, client-certificate and tunnel profiles
must add their own validated variants and matching runtime support together.
Their credential requirements and length limits must not inherit classic VNC's
eight-byte limit. Binding or changing a credential must remain compatible with
every referencing connection; authentication changes invalidate those connection
generations. There are no placeholder fields or accepted-but-unimplemented
profiles in this slice.

The authentication roadmap is tracked in
[#35041](https://github.com/vm0-ai/okou/issues/35041), with separate work for
standard/VeNCrypt profiles, SSH tunnels, Apple DH, RSA-AES, client certificates,
SASL and vendor-specific compatibility research. Each implementation must record
the exact server versions tested and distinguish client authentication, server
identity verification and full-session encryption.

The present Rust engine independently supports only RFB 3.8 / VeNCrypt 0.2 /
X509Vnc. Its TLS-owned authenticated stream must be generalized as part of any
future non-TLS or RSA-AES implementation. SSH authentication belongs to an outer
transport and does not become a VNC password method. Shared/exclusive mode is a
per-session Agent choice, independent of authentication. The VNC server decides
how to admit clients; shared sessions can interact with the same desktop.

## Deployment and rollback

The generated migration is additive: deploy it before the API code. Old API
binaries continue to work with the expanded schema and ignore the new tables.
The Runner authority slice adds only the Agent grant table; connection identity
continues to use the saved ID and generation, matching SSH. Public metadata stays unchanged.
There is no credential rewrite or destructive reset. Existing SSH data and behavior are
unchanged. The configuration API stays unavailable until the feature is
explicitly enabled; merging this change does not enable it.

Before enabling the feature, every serving API version must include VNC-aware
configuration and grant deletion cleanup. Once any VNC configuration or grant exists, that cleanup support is an
API rollback floor: disabling the feature does not erase saved credentials.
Rollback may disable `vncAccess`, but must retain VNC-aware cleanup and the additive
schema. Rolling back below this floor requires a separately verified drain and
erasure of all VNC configuration first.
Do not drop the tables as an application rollback. Runtime activation requires
the verified Runner enforcement in #34780.

## Verification

Route integration tests exercise auth, current membership, owner isolation,
rejoined owner access, secret-free output, validation, zero-to-one Agent grants,
concurrent first-host creation, live-resource retries, recreation after deletion,
optimistic concurrency, rotation, inline rollback and scoped cleanup through
production HTTP boundaries.
The dedicated migration test validates database ownership and version/trust
constraints on a disposable schema. Broader API tests and required checks run
in the PR pipeline.
