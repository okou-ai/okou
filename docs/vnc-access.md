# VNC owner configuration

VNC is an independent remote-access capability alongside SSH. The
`VncAccess` (`vncAccess`) feature switch is disabled by default, including for
staff. This configuration slice provides no Agent grants, Runner credential
delivery, control lease, UI, or CLI. Those runtime authority paths are tracked
in [#34980](https://github.com/vm0-ai/okou/issues/34980).

## Owner API

Organization session authentication and a fresh exact Clerk membership lookup
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

A credential contains a display name and a password of **1–8 printable ASCII
bytes**. Spaces are preserved. Longer or non-ASCII passwords are rejected, never
silently truncated to the classic VNC authentication limit. Credentials can be
shared by multiple saved hosts belonging to the same user, organization and
immutable Clerk membership generation.

Hosts contain a canonical DNS name or IP address, a port (default 5900), a
credential selection and explicit TLS trust. Trust is either
`{ mode: "system" }` or `{ mode: "custom_ca", caBundle: "..." }`.
A custom bundle is at most 64 KiB and contains at most eight public CA
certificates. Private keys, non-CA certificates, malformed material and insecure
trust modes are rejected. Saving configuration does not dial or verify the host.

Connection creation accepts either `credential: { id }` or
`credential: { create: { name, password } }`. Inline credential and host
creation commit atomically. A conflicting endpoint cannot leave an orphaned
inline credential. Canonical host and port are unique for one organization/user.

Repeating a creation UUID belonging to the current owner and membership returns
204 without changing any metadata or secret. A foreign UUID returns an opaque
conflict. Updates and deletes reject stale versions; the caller must refresh
metadata before deciding whether to resubmit. Password rotation advances every
referencing connection's generation. Referenced credentials cannot be deleted
until their hosts are rebound or deleted. Deleting a host retains its reusable
credential.

## Secret inventory

The only VNC encrypted field is
`vnc_credentials.encrypted_password`. It uses the existing stored-secret KMS
envelope. Passwords and ciphertext never appear in owner responses; current API
paths do not decrypt them. Public CA certificates are stored as public trust
configuration. The active KMS recovery verifier includes this field and accepts
retained snapshots that predate the VNC table. If the table exists, its exact
primary key and password column are required and every ciphertext is checked
without modification. The original rotation manifest and backfill remain
unchanged; a future rotation must include VNC in its current inventory.

## Membership and deletion lifecycle

Both business tables pin the immutable Clerk membership ID. A rejoined
membership cannot read or mutate the earlier membership's configuration. Its
first admitted write removes inaccessible older-generation hosts and
credentials before saving new configuration.

VNC admission snapshots lifecycle revisions **before** fresh membership lookup
and KMS encryption. At commit, it takes B1 erasure admission, shared scope locks,
and the owner lock, then compares those revisions. Cleanup takes an exclusive
scope lock and changes its revision even when no VNC rows exist. This rejects
delayed first writes after deletion. Membership-generation changes also fence
an older admission, including when the deletion webhook has not arrived yet.
Changed authority is a conflict, never an automatic resnapshot-and-retry.

Current user, organization and member cleanup removes hosts before credentials.
Known membership deletion events remove only their exact membership generation;
direct removal uses the membership ID returned by Clerk's delete operation.
Clerk's membership webhook contract requires that ID. A malformed event without
it does not trigger cleanup. Membership lookup and KMS calls run outside
database locks; cleanup never guesses which membership generation to erase.

`vnc_authority_revisions` retains domain-separated SHA256 scope identifiers,
revision UUIDs and membership-generation hashes after business-data deletion.
These are **pseudonymous fencing metadata**, not anonymous data. They contain
no raw user, organization or membership identifiers, passwords or hostnames.
Deleting these fences without an admission-drain protocol can reintroduce
delayed-write races.

## Deployment and rollback

The generated migration is additive: deploy it before the API code. Old API
binaries continue to work with the expanded schema and ignore the new tables.
There is no backfill or destructive reset. Existing SSH data and behavior are
unchanged. The configuration API stays unavailable until the feature is
explicitly enabled; merging this change does not enable it.

Before enabling the feature, every serving API version must include VNC-aware
deletion cleanup. Once any VNC configuration exists, that cleanup support is an
API rollback floor: disabling the feature does not erase saved credentials.
Rollback may disable `vncAccess`, but must retain VNC-aware cleanup, the additive
schema and lifecycle fences. Rolling back below this floor requires a separately
verified drain and erasure of all VNC configuration first. Do not drop the tables
as an application rollback. Runtime/Runner compatibility and activation belong
to #34980 and the remaining VNC delivery work.

## Verification

Route integration tests exercise auth, fresh membership, owner isolation,
secret-free output, validation, retries, optimistic concurrency, rotation,
inline rollback, and lifecycle races through production HTTP boundaries.
The dedicated migration test validates database ownership and version/trust
constraints on a disposable schema. Broader API tests and required checks run
in the PR pipeline.
