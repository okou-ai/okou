# VNC configuration and authority

VNC is an independent remote-access capability alongside SSH. The
`VncAccess` (`vncAccess`) feature switch is disabled by default, including for
staff. Owner configuration, chat host selection, metadata inventory and
private Runner authority are described in
[Runner VNC authority](runner-vnc-authority.md).
The Runner, owner configuration and Agent inventory support the exact X509None,
X509Vnc, X509Plain, QEMU-specific X509SASL/SCRAM-SHA-256, SSH-protected
Apple classic password, Apple DH, Apple Direct SRP and Apple RSA/SRP profiles. **Certificate-free** X509None requires an explicit owner selection:
its TLS certificate verifies the **server** and encrypts the stream, but it
provides **no VNC client authentication**. Any other client with access to the
VNC listener may control the desktop. An SSH route authenticates the selected
SSH hop only; it cannot establish isolation of the downstream VNC listener.
The owner must choose and manage the destination's exposure accordingly.
The feature remains unavailable until a separate activation decision.

## Advisory Lock Cleanup Release 1

VNC is not GA. Configuration and owner cleanup no longer acquire advisory
locks, and no compatibility fallback is added for its old writer shape.

A configuration write checks live Clerk membership in its route before any
SQL; Clerk remains the membership authority. KMS encryption and endpoint
preparation run outside the transaction. The mutation then checks the requested
credential revision or host generation with an ordinary read and executes its
bounded conditional SQL in a short transaction. It takes no member-row or other
explicit row lock and reads no `org_members_metadata` lifecycle identity.

User, organization and membership erasure delete the scoped VNC hosts and then
their credentials in one local transaction, without locking member rows. VNC is
a non-money path, so no concurrency protection is added against a write admitted
before erasure that commits after it; Runner access still rechecks live Clerk
membership before use. Read-only VNC admission does not initialize member
preferences.

Credential rotation retains the existing revision and advances every referencing
host's generation. Connection updates and deletes use their existing generation
conditions. Override writes insert through ordinary cascading foreign keys to
their host and thread, so deleting a host also removes its access overrides. Live Runner
membership and credential revision checks remain unchanged. No App/Runner wire
contract, persisted field, coordination table or authorization flag is added.

The separate obsolete Agent grant-table contraction is not part of this change.
Shared initial-chat creation still has its own transaction-aware override
validation/insert helpers; retiring that wider command graph is tracked by the
Release 1 API transaction inventory, not certified by the VNC lock removal.

## Supported profiles and rollout state

| Boundary                           | X509None                                     | X509Vnc                                      | X509Plain                                     | Activation meaning                     |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Rust RFB engine                    | Independently exercised with pinned TigerVNC | Independently exercised with pinned TigerVNC | Independently exercised with pinned TigerVNC  | Protocol evidence only                 |
| Private API and current Runner     | Exact `none` / `x509_none` pair              | Exact `vnc_password` / `x509_vnc` pair       | Exact `username_password` / `x509_plain` pair | Runtime capability, not owner exposure |
| Owner API, app and Agent inventory | Exposed only by explicit selection           | Exposed                                      | Exposed                                       | Available only behind `VncAccess`      |
| Older X509Vnc-only Runner          | `unsupported_profile` before KMS             | Supported                                    | `unsupported_profile` before KMS              | Fail closed; no downgrade              |
| Production switch                  | Disabled                                     | Disabled                                     | Disabled                                      | Separate activation decision           |

Certificate-free X509None is also an exact `none` / `x509_none` pair for direct and saved-SSH
routes. The RFB engine has TigerVNC fixture coverage. Owner/API/Runner support
requires an upgraded Runner that advertises the exact pair and a migration
allowing a null credential only for X509None; an older Runner rejects it without
downgrading. This is not evidence of a production Agent/server acceptance run.

Acceptance must name the exact server and Runner versions and distinguish
engine-only evidence, controlled Runner integration and a real Agent session.
Neither the matrix nor a merged implementation turns on the feature.

## QEMU client certificate profiles (not production-activated)

Two new owner-selected saved profiles use the same VeNCrypt wire subtypes but **new exact authentication pairs**: `client_certificate` / `x509_none` has no inner RFB password, and `client_certificate_vnc_password` / `x509_vnc` requires a 1–8 printable-ASCII-byte classic password. They do not change existing `none` / `x509_none` or `vnc_password` / `x509_vnc` records. Both verify the server certificate and saved DNS/IP identity with system or explicitly selected custom CA. Direct and saved-SSH routes retain their separate destination/authority checks. The Agent sees only the non-secret profile label and host metadata; only the winning authorized Runner receives a decrypted key through a private, no-store resolve response. A new Runner passes the identity to the separate certificate-required RFB engine; old Runners reject the exact new tuple **before KMS**. No downgrade to a certificate-free tuple is possible.

Owner input accepts 1–8 PEM X.509 client certificates (at most 64 KiB total DER) and one matching unencrypted PKCS#8 PEM private key (at most 16 KiB DER). Encrypted private keys and passphrases are unsupported and rejected. The API checks structure, public-key match and leaf validity at save; the server ultimately decides certificate-chain acceptance and validity during a session. KMS envelope encryption holds the normalized chain/key as one private field; the inner VNC password, if present, uses its own KMS envelope. Metadata never contains either, and the UI never reloads a key. Replacing authentication rotates the whole identity and optional password, increments the credential revision and every referencing connection generation, invalidating active authority on recheck. Deleting an unused credential removes its ciphertext; backend and Runner retain in-memory plaintext only transiently for a resolve/handshake, while TLS may retain a signing key until session teardown. JavaScript runtime copies are not guaranteed to be zeroized immediately. Key backup, rotation and revocation are the owner's responsibility; the client does not claim CRL/OCSP coverage or automatic renewal.

**Server-side policy is separate:** QEMU must be configured with a client CA and `verify-peer=on`, with network ingress restricted to intended peers. A TLS CertificateRequest and even a successful client-certificate handshake do not prove this setting; QEMU 8.2.2 with `verify-peer=off` still requests a client certificate and accepts a wrong-CA identity. Require independent server configuration and wrong-client rejection evidence before any production activation. Loopback engine tests and CI are not real owner→Agent→Runner→QEMU acceptance. `VncAccess` remains disabled by default; no production QEMU or OpenSSH change is implied.

## QEMU X509SASL / SCRAM-SHA-256 (not production-activated; #37466)

The owner may select the **new exact** `qemu_scram_sha256` credential and
`qemu_x509_sasl` security pair. It is QEMU's observed VeNCrypt subtype **263**
with SCRAM-SHA-256, not the generic X509SASL subtype 264, X509Plain/PLAIN,
GSSAPI or a client-certificate login. The username is 1–255 printable ASCII
bytes excluding space, comma and equals; the password is 1–1023 printable
ASCII bytes including spaces (preserved verbatim). No SASL stream security
layer is negotiated: server-verified TLS protects the entire desktop. The
owner chooses system or a bounded custom CA and the server certificate
DNS/IP identity independently of the SASL username, as well as a direct or
saved authorized SSH route. The engine rejects the wrong subtype, mechanism,
server proof and security result rather than downgrading.

The existing KMS password envelope holds this distinct credential; the owner
API validates before encryption and again after decryption on private handoff.
Metadata includes the username and method but never the password. Rotation
increments the revision and every referring connection generation; active
sessions stop on the next authority recheck. The Runner must advertise the exact direct or SSH tuple before the API
decrypts the password, and repeats credential/transport checks before opening
a socket. Migration `1304_bright_grim_reaper` adds only the exact storage
checks; this slice adds no production QEMU service, network ingress,
certificate lifecycle or feature activation. The separately pinned QEMU/Cyrus engine fixture proves only the
engine handshake, not a real owner→Agent→Runner PNG. Record that full positive
and negative acceptance separately before claiming production readiness.

Optional Mac classic VNC password adds the **separate** `vnc_password` /
`apple_vnc_password` pair for bare RFB security type 2. It reuses the 1–8
printable-ASCII-byte credential shape of X509Vnc but **not** its X.509 trust
or TLS profile. Configure the Mac's optional “VNC viewers may control screen
with password” setting yourself with a distinct password (not a Mac login
password), then deliberately choose this profile, a saved host-key-verified
SSH connection ending on the Mac, and literal `127.0.0.1` or `::1` as the RFB
destination. The type-2 password only authenticates the client: it does not
authenticate the RFB server or encrypt the desktop. SSH protects this Okou
connection, **not** the Mac's TCP/5900 listener; depending on Mac firewall and
network settings, other clients may reach its weak-password service. The
owner chooses whether that exposure is acceptable; Okou does not require
host-side isolation, measure external reachability or enable the Mac option
automatically. A saved SSH host key authenticates the selected endpoint but
cannot exclude an onward proxy. Older Runners without the exact tuple return
`unsupported_profile` before password decryption. No direct route or fallback
from X509Vnc is admitted; `VncAccess` remains default-off.

Apple Screen Sharing adds an exact `apple_dh_username_password` / `apple_dh`
pair. The Rust engine authenticates Apple RFB security type 30, which neither
authenticates the VNC server nor encrypts the subsequent desktop session.
Owner configuration therefore admits it only through a saved, independently
authorized SSH host and a literal `127.0.0.1` or `::1` RFB destination on that
host. Its credential fields are each 1–63 UTF-8 bytes without NUL. Old Runners
do not advertise the Apple/SSH tuple and receive `unsupported_profile` before
decryption. The owner-managed SSH host key authenticates the selected SSH
server, but cannot prove that server does not proxy its loopback connection
onward; owners must select a Mac host they control. This profile also remains
behind the default-off `VncAccess` switch.

Apple Direct SRP adds a separate `apple_srp_username_password` / `apple_srp`
pair for Apple RFB security type 36. It does not change the meaning of Apple DH
or X.509 credentials. The SRP account and server proofs are verified by the
Rust engine, while the saved SSH route protects the entire desktop stream.
The same independently authorized SSH host and literal loopback destination
restriction applies. SRP usernames accept 1–255 UTF-8 bytes and passwords
1–1023 UTF-8 bytes, without NUL. Old Runners must return
`unsupported_profile` before decrypting the credential. SSH host-key trust
identifies the chosen endpoint but cannot rule out an onward proxy. This
profile also remains behind the default-off `VncAccess` switch.

Apple RSA/SRP adds a distinct `apple_rsa_srp_username_password` /
`apple_rsa_srp` pair for Apple RFB security type 33. The Rust engine verifies
SRP server proof and the security result, but the RFB-provided RSA key does
not independently establish host identity or protect post-authentication
frames. Owner configuration requires verified SSH ending on a Mac the owner
controls, a saved SSH host with its host key verified, and the literal RFB
loopback destination `127.0.0.1` or `::1`. No direct route, arbitrary SSH
proxy, or downgrade to type 30 or 36 is admitted. RSA/SRP usernames accept
1–234 UTF-8 bytes and passwords 1–1023 UTF-8 bytes, without NUL. The Runner
requires the exact capability tuple before KMS decryption. This profile
remains behind default-off `VncAccess`; engine or code delivery alone is not
product activation. Other macOS versions and unobserved security modes remain
unverified.

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
exposes `username` only for `username_password`, `qemu_scram_sha256`,
`apple_dh_username_password`, `apple_srp_username_password` or
`apple_rsa_srp_username_password`; it never exposes a password or
ciphertext. Credentials can be shared by multiple saved connections belonging
to the same user and organization.

Hosts contain a canonical DNS name or IP address, a port (default 5900),
explicit `security` and, for password-backed profiles, a credential selection.
Owner configuration accepts `{ type: "x509_none", trust }`,
`{ type: "x509_vnc", trust }`, `{ type: "x509_plain", trust }` and
`{ type: "qemu_x509_sasl", trust }`; trust is
either `{ mode: "system" }` or `{ mode: "custom_ca", caBundle: "..." }`.
Each X509 security variant may also carry `serverName`, a separately
canonicalized DNS name or IP identity for certificate verification. Omitting it
means use the saved VNC host; it never replaces the socket destination. Apple
security variants do not accept `serverName` or an X.509 trust policy.
The exact stored pairs are `none` / `x509_none` (without a credential),
`client_certificate` / `x509_none` (with an encrypted identity credential),
`client_certificate_vnc_password` / `x509_vnc` (with an encrypted identity and password),
`vnc_password` / `x509_vnc`, `vnc_password` / `apple_vnc_password`,
`username_password` / `x509_plain`, `qemu_scram_sha256` / `qemu_x509_sasl`,
`apple_dh_username_password` / `apple_dh`,
`apple_srp_username_password` / `apple_srp`, and
`apple_rsa_srp_username_password` / `apple_rsa_srp`. None of the Apple profiles
has an X.509 trust bundle or certificate identity; their routes are restricted as
described above.
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
only when the Run's chat allows that VNC host and its exact SSH host. Older
Runners omit transport, which means direct-only; an authorized SSH row returns
`unsupported_profile` before VNC credential decryption and never falls back to
public TCP.

Connection creation accepts `credential: { type: "none" }` only with
`security: { type: "x509_none", trust, ... }`; certificate-bearing X509None instead requires a separate certificate credential. All other profiles require either
`credential: { id }` or `credential: { create: { name, authentication } }`.
Certificate-free X509None metadata contains `{ credential: { type: "none" } }` rather than
`credentialId` or `credentialName`. Inline credential and host creation commit
atomically. Each saved connection has its own UUID; multiple connections can
share the same canonical host and port, including the same credential. This permits independent login and security configurations, matching
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
compatible credential and security type, or by explicitly selecting
`{ type: "none" }` together with X509None. Referenced credentials cannot be deleted
until their hosts are rebound or deleted. Deleting a host retains its reusable
credential.

## Owner setup in the app

With `vncAccess` enabled, open **Connectors → Remote control** at
`/connectors?scope=remote-control&type=vnc`. The VNC type filter shows saved
connections and reusable credentials; VNC controls are absent when the switch
is disabled. Choose **Direct from Runner** or **Through saved SSH host**. The
SSH choice lists the current owner's secret-free saved SSH hosts; SSH
credentials and learned host-key material are not copied into VNC state. A
missing or deleted selection blocks saving and preserves the draft until the
owner selects another SSH host or explicitly switches to Direct.

The **RFB destination host** and **RFB destination port** identify the socket
the VNC client opens. For an SSH route, they are resolved and reached from the
selected SSH server, not from the Runner. The SSH server must therefore have
network access to that destination. SSH authenticates and encrypts only the
Runner-to-SSH-server hop. On the onward RFB connection, X509None verifies the
server and encrypts the session without authenticating the VNC client;
X509Vnc and X509Plain also authenticate the client. Switching routes preserves
the draft endpoint, security, credential and SSH selection instead of rewriting
them.

Select a saved VNC credential or create one for password-backed profiles.
Certificate-free X509None has no VNC credential; the owner must explicitly select it, and the
settings UI displays the no-client-authentication warning both while editing
and on the saved connection. It retains certificate verification (system or
custom CA), does not allow a certificate bypass, and is never an implicit
fallback when another authentication method fails. The certificate-verified choices are
VeNCrypt X509Vnc (certificate-verified TLS plus a classic VNC password) or
VeNCrypt X509Plain (certificate-verified TLS plus username/password
authentication), or QEMU X509SASL subtype 263 (verified TLS plus bounded
SCRAM-SHA-256); Mac VNC has separate SSH-only Apple classic VNC password,
DH, Direct SRP and RSA/SRP choices. Standalone macOS Screen Sharing is not yet
verified; these profiles do not establish support for that mode. Classic
passwords must contain 1–8 printable ASCII characters.
X509Plain usernames accept 1–255 UTF-8 bytes and passwords accept 1–1023 UTF-8
bytes. Spaces are significant and embedded NUL is rejected. Changing profiles
clears draft authentication material and only exact compatible credentials are
selectable. Moving between X509None and a password-backed profile requires an
explicit credential change; older Runners lacking the exact `none` / `x509_none`
capability return `unsupported_profile` before any credential lookup or KMS
operation. The app does not offer unsupported authentication profiles or an
insecure certificate bypass.

Choose system certificate authorities or paste the public CA certificates
needed to verify the server. Custom trust accepts at most eight CA certificates
and 64 KiB; do not paste private keys or leaf server certificates. **TLS
certificate identity** is separate from the RFB destination: leave it blank to
verify the certificate against the RFB destination host, or set the DNS/IP name
actually covered by the server certificate. It never changes where the socket
connects. Saved cards show the route, selected SSH host, RFB destination and
effective certificate identity before chat host permission is selected. Saving
records configuration; it does not test reachability or authenticate a session.

An SSH host referenced by a VNC route cannot be deleted. Rebind every dependent
VNC route, switch it explicitly to Direct where that destination is valid, or
delete it first. The app reports this dependency without cascading, clearing or
silently converting the VNC route.

For a Mac VNC service, choose the exact Apple DH, Apple Direct SRP or Apple
RSA/SRP profile and a saved, host-key-verified SSH connection terminating on
that same controlled Mac. The app sets the RFB destination to `127.0.0.1` by
default; select `::1` explicitly if that Mac uses IPv6 loopback. Port 5900 is
a default, not a fixed requirement. The Add host dialog follows the SSH form:
display name first, then security profile, its dependent route/target settings,
and compatible credentials. Apple profiles have no Direct option or free-form
RFB destination. For X509 profiles, Direct and saved SSH remain explicit choices;
a private or loopback IP literal under Direct must be corrected by the owner,
not automatically rerouted. The app hides X.509 trust fields for Apple and
offers only profile-matching credentials. SSH protects the entire VNC session;
neither Apple DH nor SRP server proof replaces this transport protection.
Saving does not verify Mac VNC settings or prove the SSH server has no
downstream proxy. A real product session must separately validate saved-host
creation, chat host permission, screenshot and bounded input before activation.

Adding or recreating a VNC host does not grant Agent-wide permission or change
any chat's access. New hosts default off until their owner enables a host
default or the chat explicitly overrides it. Retired Agent grant rows do not
authorize Run access and the owner grant endpoints are retired. The physical
Agent grant tables are removed by the separate #37272 migration; until it is
actually deployed, old rows may still exist in the database.

Manage VNC access with each saved host's chat default and the chat's `On`, `Off`,
or `Use default` choice. Direct rows appear in live Run inventory when the Run's
chat permits their exact VNC hosts. An SSH-backed row also requires the chat to
permit the referenced SSH host; revoking that SSH permission removes only the
SSH-backed rows from subsequent inventory reads and authorization checks. The
inventory remains secret-free and does not expose the route, SSH reference,
trust material, certificate identity or generations. Like SSH, it
includes `availability: { status: "ready" }` for configured hosts and
`{ status: "blocked", reason: "needs_rebind" }` for authorized VNC hosts whose
underlying SSH host needs Cloudflare Access rebinding. Blocked IDs are diagnostic
only; their owners must rebind the SSH host or explicitly choose Direct, and
fresh Runner admission remains unavailable until then. Only use a current ready
ID for a new session; ready is not a connectivity test. The VNC inventory has
one required `availability` field; this pre-GA feature does not retain a legacy
response shape or CLI fallback. This repair does not activate `VncAccess`.
Agents select shared or exclusive mode when opening each session; the server
decides admission and may override the requested mode. The settings page adds
no controller lock.

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
is not production activation evidence. The independent SSH matrix and its
disposable-host procedure are documented in
[OpenSSH plus TigerVNC interoperability](../crates/runner/tests/VNC_SSH_INTEROPERABILITY.md).
That ignored lane is explicit evidence, not ordinary CI or activation.

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
organization/user pair as their owner, matching SSH configuration. The retired
`agent_vnc_access` table is dropped by migration
`1288_drop_retired_agent_grant_tables` in #37272, **after** the code-only API
release in PR #37305 was promoted and older invocations drained. The migration
is not a production receipt until deployed; current code does not read or
write the retired table, and only current chat host permission authorizes Run
access. Rollback to a pre-#37305 API will be unsupported after the drop.
Current membership authorizes access to that owner's configuration. If the user leaves and rejoins before cleanup removes
the configuration, it remains the same owner's data and is accessible again.
Each saved connection retains its own identity across membership changes.

Mutations and cleanup take no locks (see Advisory Lock Cleanup Release 1).
Cleanup deletes hosts before credentials. A request that passed membership
admission before cleanup and only enters its write transaction afterward can
still finish; no VNC authority ledger or creation receipt prevents it.

Current user, organization and member cleanup removes hosts before credentials.
Member cleanup removes the organization's configuration for that user. It follows
the existing organization/user cleanup path, including when a deletion event
arrives after the user has rejoined. Membership checks and KMS calls run outside
database locks.

## Authentication extension boundary

Credential methods describe the supplied authentication material; connection
security profiles describe the owner's selected wire authentication and server
trust policy. Owner persistence accepts exactly the five pairs listed above.
The connection stores the selected
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
Persisted discriminator meanings are immutable: Apple DH, Apple Direct SRP
and Apple RSA/SRP each use distinct methods and profiles and do not reinterpret
X509Plain or each other. A later profile extends the
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
X509Vnc, X509Plain, SSH-only Apple DH, SSH-only Apple Direct SRP and SSH-only
Apple RSA/SRP authentication flows. SSH authentication belongs to an
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

The Apple DH generated migration expands only the exact profile and credential
shape checks. It leaves retained X509 rows, generations, grants and the direct
default untouched. API readers of Apple rows and Runner support must be
deployed before admitting those rows; rollback below that reader floor is unsafe
once they exist. No merge enables the switch or authorizes production rollout.

The Apple Direct SRP migration similarly expands only the exact credential,
profile and trust checks; existing row values, generations, grants and the
direct default remain intact. New API readers and current Runners are required
before an SRP row is admitted. An older Runner fails the exact capability check
before KMS; an older API is not a safe rollback target after SRP rows are
stored. The rollback floor is therefore the first API revision that reads and
preserves these distinct SRP discriminators. Merging this migration does not
activate `VncAccess`.

The Apple RSA/SRP generated migration extends only the exact credential,
profile and trust constraints while retaining all X509 and Apple rows,
generations, grants, SSH references and the direct default. Because `VncAccess`
has never been activated, this change does not require mixed-version Runner
support or a production-data rollback exercise. It still requires all serving
API readers to understand the new discriminators before a type 33 row can be
stored; a revision that cannot read these rows is not a safe rollback target
once they exist. This migration does not activate `VncAccess`.

The X509None profile migration `1289_thick_bruce_banner` follows the separate
1288 grant-table contraction. It allows a null credential only for the exact
`none` / `x509_none` pair; existing saved rows retain their meaning. Deploy the
compatible API before the new Runner: an old strict API rejects the new
Runner's advertised pairs even for legacy connections. Old Runners reject
X509None rows before KMS. An old App cannot be relied upon to manage the new
credentialless response, and the old API's credential inner join omits these
rows. Once one exists, disabling the switch does not make an old API a safe
rollback target. The exact old/new App, API and Runner matrix and the separate
1288 deployment gate are in [deployment compatibility](deployment-compatibility.md#vnc-x509none-owner-selected-rollout-default-off).

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
The bounded old-Runner omission fallback must remain until replacement Runners
are deployed and every Run started on the prior revision has exceeded the
two-hour maximum lifetime. A merge, green CI or preview success does not by
itself prove that deployment-and-drain gate.
After new-profile rows are permitted, rolling back to a pre-reader API is unsafe;
disabling the feature does not erase saved credentials. Any later rollback below
that floor requires a separately verified disablement, drain and VNC data deletion.
Owner-facing X509Plain support does not activate the default-off feature. Any
activation still requires separately reviewed deployment and acceptance
evidence.

## Verification

Route integration tests exercise auth, current membership, owner isolation,
rejoined owner access, secret-free output, validation, retained zero-to-one
default-off first-host creation, concurrent host creation, live-resource retries,
recreation after deletion, optimistic concurrency, rotation, inline rollback
and scoped cleanup through production HTTP boundaries.
Focused inventory coverage also creates direct and SSH-backed rows for a chat,
proves that chat permission for the VNC host alone exposes only the direct row,
proves that permission for the exact SSH host exposes the tunneled row, and
proves that revoking that SSH permission removes the tunneled row without
broadening the response shape. Platform Router tests exercise direct and
SSH editing, route switching without draft loss, separate destination and
certificate identity, stale SSH references, topology summaries and actionable
restrictive-deletion errors.
The dedicated migration test seeds populated pre-change credentials,
connections, grants and unrelated owner data, applies the profile and typed-route
migrations, and verifies row identity, ciphertext, versions, trust configuration
and grants are unchanged. It also verifies the authentication backfill, retained
direct transport default, both exact pairs, same-owner SSH reference, restrictive
deletion, route/server-identity checks, credential compatibility, version and
trust constraints on a disposable schema. Broader API tests and required checks
run in the PR pipeline.

The ignored Runner interoperability lane composes the production SSH authority,
direct-tcpip forwarding, VNC authority, session, capture and close paths against
an explicitly recorded installed OpenSSH version and TigerVNC
`1.13.1+dfsg-2build2`. It covers password and public-key SSH crossed with
X509Vnc and X509Plain, pins the SSH host key and `localhost` certificate
identity, records the exact forwarded destination, and requires teardown of the
disposable account, daemons and generated material. Existing deterministic
tests retain the negative matrix for bad host keys, wrong credentials,
certificate mismatch, unsupported Runner tuples, route/revocation generations,
cancellation and cleanup.
