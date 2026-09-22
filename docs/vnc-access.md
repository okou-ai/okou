# VNC configuration and authority

VNC is an independent remote-access capability alongside SSH. The
`VncAccess` (`vncAccess`) feature switch is disabled by default, including for
staff. Explicit owner/Agent grants, metadata inventory and private Runner
authority are described in [Runner VNC authority](runner-vnc-authority.md).
The Runner, owner configuration and Agent inventory support the exact X509Vnc
and X509Plain profiles. The feature remains unavailable until a separate
activation decision.

## Supported profiles and rollout state

| Boundary                                 | X509Vnc                                                                   | X509Plain                                                                 | Activation meaning                     |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| Rust RFB engine                          | Supported and independently exercised against the pinned TigerVNC fixture | Supported and independently exercised against the pinned TigerVNC fixture | Protocol evidence only                 |
| Private API and current Runner           | Exact `vnc_password` / `x509_vnc` pair                                    | Exact `username_password` / `x509_plain` pair                             | Runtime capability, not owner exposure |
| Owner API, app and Agent inventory       | Exposed                                                                   | Exposed                                                                   | Available only behind `VncAccess`      |
| Runner without the advertised exact pair | Supported                                                                 | `unsupported_profile` before KMS                                          | Fail closed; no downgrade              |
| Production switch                        | Disabled                                                                  | Disabled                                                                  | Separate activation decision           |

Acceptance must name the exact server and Runner versions and distinguish
engine-only evidence, controlled Runner integration and a real Agent session.
Neither the matrix nor a merged implementation turns on the feature.

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

A credential contains a display name and typed `authentication`. Classic
`{ method: "vnc_password", password }` accepts **1–8 printable ASCII bytes**.
`{ method: "username_password", username, password }` accepts a username of
**1–255 UTF-8 bytes** and a password of **1–1023 UTF-8 bytes**. Embedded NUL is
rejected and password spaces are preserved. Metadata exposes `authMethod` and
exposes `username` only for `username_password`; it never exposes a password or
ciphertext. Credentials can be shared by multiple saved connections belonging
to the same user and organization.

Hosts contain a canonical DNS name or IP address, a port (default 5900), a
credential selection and explicit `security`. Owner configuration accepts
`{ type: "x509_vnc", trust }` and `{ type: "x509_plain", trust }`; trust is
either `{ mode: "system" }` or `{ mode: "custom_ca", caBundle: "..." }`.
Each security variant may also carry `serverName`, a separately canonicalized
DNS name or IP identity for future certificate verification. Omitting it means
use the saved VNC host; it never replaces the socket destination.
The exact stored pairs are `vnc_password` / `x509_vnc` and
`username_password` / `x509_plain`.
A custom bundle is at most 64 KiB and contains at most eight public CA
certificates. Private keys, non-CA certificates, malformed material and insecure
trust modes are rejected. Saving configuration does not dial or verify the host.

Connection create and update accept an optional strict outer `transport`:
`{ type: "direct" }` or `{ type: "ssh", connectionId }`. Omission on create
means direct and omission on update preserves the current transport. SSH
references must belong to the same organization/user owner and are deleted only
after every VNC reference is reassigned or removed. Direct metadata retains its
legacy response shape; SSH metadata includes the typed reference. Private and
loopback literal VNC destinations require SSH transport. Current Runners
advertise exact authentication/security/transport tuples and execute an SSH row
only when the Agent independently holds both VNC and SSH grants. Older Runners
omit transport, which means direct-only; an SSH row returns
`unsupported_profile` before VNC credential decryption and never falls back to
public TCP.

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
resource and stop retrying its creation after deletion. Updates and deletes
reject stale versions; the caller must refresh metadata before deciding whether
to resubmit. Credential authentication changes within the same method advance
every referencing connection's generation. A referenced credential cannot
change methods; change a connection's profile by atomically selecting a
compatible credential and security type. Referenced credentials cannot be deleted
until their hosts are rebound or deleted. Deleting a host retains its reusable
credential.

## Owner setup in the app

With `vncAccess` enabled, open **Connectors → Remote access → VNC**.
The independent VNC page at `/connectors/vnc` manages hosts and reusable
credentials. Add a host's hostname or IP address and port (default 5900), then
select a saved credential or create one. The initial supported profile is
VeNCrypt X509Vnc (certificate-verified TLS plus a classic VNC password) or
VeNCrypt X509Plain (certificate-verified TLS plus username/password
authentication). Classic passwords must contain 1–8 printable ASCII characters.
X509Plain usernames accept 1–255 UTF-8 bytes and passwords accept 1–1023 UTF-8
bytes. Spaces are significant and embedded NUL is rejected. Changing profiles
clears draft authentication material and only exact compatible credentials are
selectable. The app does not offer unsupported authentication profiles or an
insecure certificate bypass.

Choose system certificate authorities or paste the public CA certificates
needed to verify the server. Custom trust accepts at most eight CA certificates
and 64 KiB; do not paste private keys or leaf server certificates. The server
certificate must identify the configured hostname or IP address. Saving a host
records configuration; it does not test reachability or authenticate a session.
The current app does not expose the saved SSH transport or separate certificate
identity controls; those remain behind later UI/runtime delivery.

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
rotate its authentication; explicitly replacing the password (and X509Plain
username) affects every bound host. A saved credential's authentication method
is immutable; create a different credential to change methods. Saved passwords
are never returned or prefilled. X509Plain usernames are non-secret metadata and
may be shown or prefilled during explicit replacement. A referenced credential
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
retained-data rollback for the base profile were verified in
[#35299](https://github.com/vm0-ai/okou/issues/35299). X509Plain full-path
verification is recorded in the
[head-specific acceptance record](vnc-x509plain-acceptance.md); merging support
is not production activation evidence.

## Secret inventory

The only VNC encrypted field is
`vnc_credentials.encrypted_password`. It uses the existing stored-secret KMS
envelope. Passwords and ciphertext never appear in owner responses; current API
configuration paths do not decrypt them. The private Runner resolve endpoint
decrypts only after current authorization and profile validation. Usernames,
SSH connection references, certificate server identities and public CA
certificates are stored as public configuration. The active KMS
recovery verifier includes this field and accepts
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
trust policy. Owner persistence accepts exactly `vnc_password` with `x509_vnc`
and `username_password` with `x509_plain`. The connection stores the selected
authentication method explicitly; a same-row check and composite credential
foreign key enforce both pair and reference compatibility. Unknown methods,
profiles and unsupported trust shapes are rejected, with no implicit default.

Credentialless and client-certificate profiles must add their own validated
variants and matching runtime support. SSH is a typed outer transport rather
than a credential or security profile. Runner composes it through the existing
verified, Run-owned SSH authority and retains both generations for live checks.
New credential requirements
and length limits must not inherit classic VNC's eight-byte limit. Binding or
changing a credential must remain compatible with every referencing connection;
authentication changes invalidate those connection generations.
Persisted discriminator meanings are immutable: a later profile extends the
allowed values and adds its concrete typed fields or references, but cannot
reinterpret an existing value or require clearing saved VNC state. Every schema
extension must exercise its migration against populated credentials, connections
and grants. A protocol with different credential bounds gets a new method value
even when its UI also looks like username/password; it does not broaden
`username_password`.

Run host inventory exposes both exact pairs without credentials or trust
material. The private resolve path executes X509Plain only when the requesting
Runner advertises that exact pair. An older Runner advertises only X509Vnc, so
resolve reports a saved X509Plain connection as unsupported and fails closed
before KMS. There is no compatibility downgrade.

The authentication roadmap is tracked in
[#35041](https://github.com/vm0-ai/okou/issues/35041), with separate work for
standard/VeNCrypt profiles, SSH tunnel runtime, Apple DH, RSA-AES, client certificates,
SASL and vendor-specific compatibility research. Each implementation must record
the exact server versions tested and distinguish client authentication, server
identity verification and full-session encryption.

The Rust protocol engine and private Runner contract support the policy-selected
X509Vnc and X509Plain authentication flows. SSH authentication belongs to an
outer transport and does not become a VNC password method. Shared/exclusive mode
is a per-session Agent choice, independent of authentication. The VNC server
decides how to admit clients; shared sessions can interact with the same desktop.

## Deployment and rollback

The feature is disabled and has never been activated, but its persisted state is
still retained. Three generated migrations expand credentials first, add the
connection authentication method with a temporary `vnc_password` default, then
remove that default. Existing constraints prove every pre-change credential and
connection is the exact `vnc_password` / `x509_vnc` pair, so the temporary default
is a bounded backfill rather than a policy inference. The final schema requires
all new writes to select a method explicitly. No VNC credentials, connections or
Agent grants are deleted or rewritten.

Two later generated migrations establish the SSH route reference in dependency
order: the first adds the composite SSH connection owner key, and the second adds
the direct-default transport discriminator, nullable SSH reference, optional
X.509 server identity, restrictive same-owner foreign key, lookup index and
shape checks. Existing and old-writer rows remain direct because the database
default is intentionally retained.

The configuration API remains unavailable until the feature is explicitly
enabled; merging this change does not enable it, authorize an out-of-band
migration, or activate UI or Runner support.

Before enabling the feature, every serving API must include the new owner reader,
VNC-aware cleanup and the runtime/UI slices required for the selected activation.
Before any SSH-backed VNC row is admitted, every serving and rollback API must
understand this transport schema. Deploy the tuple-aware API before the Runner:
the new API preserves the exact old direct handoff for transport-omitting
Runners, while the older strict API rejects a new Runner's transport fields.
There is no request retry, inferred route or downgrade. Once such a row exists,
rolling the API below the typed-route slice is unsafe: an old writer cannot
preserve or validate its transport semantics. Disabling the feature does not
remove that rollback floor.
After new-profile rows are permitted, rolling back to a pre-reader API is unsafe;
disabling the feature does not erase saved credentials. Any later rollback below
that floor requires a separately verified disablement, drain and VNC erasure.
Owner-facing X509Plain support does not activate the default-off feature. Any
activation still requires separately reviewed deployment and acceptance
evidence.

## Verification

Route integration tests exercise auth, current membership, owner isolation,
rejoined owner access, secret-free output, validation, zero-to-one Agent grants,
concurrent first-host creation, live-resource retries, recreation after deletion,
optimistic concurrency, rotation, inline rollback and scoped cleanup through
production HTTP boundaries.
The dedicated migration test seeds populated pre-change credentials,
connections, grants and unrelated owner data, applies the profile and typed-route
migrations, and verifies row identity, ciphertext, versions, trust configuration
and grants are unchanged. It also verifies the authentication backfill, retained
direct transport default, both exact pairs, same-owner SSH reference, restrictive
deletion, route/server-identity checks, credential compatibility, version and
trust constraints on a disposable schema. Broader API tests and required checks
run in the PR pipeline.
