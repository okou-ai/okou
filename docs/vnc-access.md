# VNC owner configuration

VNC is an independent remote-access capability alongside SSH. The
`VncAccess` (`vncAccess`) feature switch is disabled by default, including for
staff. This configuration slice provides no Agent grants, Runner credential
delivery, control lease, UI, or CLI. Those runtime authority paths are tracked
in [#34980](https://github.com/vm0-ai/okou/issues/34980).

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

A credential contains a display name and a password of **1–8 printable ASCII
bytes**. Spaces are preserved. Longer or non-ASCII passwords are rejected, never
silently truncated to the classic VNC authentication limit. Credentials can be
shared by multiple saved hosts belonging to the same user and organization.

Hosts contain a canonical DNS name or IP address, a port (default 5900), a
credential selection and explicit TLS trust. Trust is either
`{ mode: "system" }` or `{ mode: "custom_ca", caBundle: "..." }`.
A custom bundle is at most 64 KiB and contains at most eight public CA
certificates. Private keys, non-CA certificates, malformed material and insecure
trust modes are rejected. Saving configuration does not dial or verify the host.

Connection creation accepts either `credential: { id }` or
`credential: { create: { name, password } }`. Inline credential and host
creation commit atomically. A conflicting endpoint cannot leave an orphaned
inline credential. Canonical host and port are unique for one
organization/user pair.

Like SSH configuration, repeating the UUID of an existing resource belonging to
the current owner returns 204 without changing metadata or secrets.
A UUID occupied by another owner returns an opaque conflict.
Deletion physically removes the row, so a subsequent create with that UUID is a
new resource starting at version 1. Clients should use a new UUID for each new
resource and stop retrying its creation after deletion. Updates and deletes reject stale versions;
the caller must refresh metadata before deciding whether to resubmit. Password
rotation advances every referencing connection's generation. Referenced credentials cannot be deleted
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

The only VNC tables are `vnc_credentials` and `vnc_connections`. Both use the
organization/user pair as their owner, matching SSH configuration. Current
membership authorizes access to that owner's configuration. If the user leaves
and rejoins before cleanup removes the configuration, it remains the same
owner's data and is accessible again. Endpoint uniqueness applies to that owner
across membership changes.

Mutation transactions use the existing B1 erasure admission, shared cleanup-scope
locks and an exclusive owner lock. Cleanup takes an exclusive scope lock and
deletes hosts before credentials. These locks serialize overlapping transactions
without retaining a VNC authority ledger or creation receipts. They do not cancel
a request that passed membership admission before cleanup and only enters its
write transaction afterward; such an in-flight request can still finish.

Current user, organization and member cleanup removes hosts before credentials.
Member cleanup removes the organization's configuration for that user. It follows
the existing organization/user cleanup path, including when a deletion event
arrives after the user has rejoined. Membership checks and KMS calls run outside
database locks.

## Deployment and rollback

The generated migration is additive: deploy it before the API code. Old API
binaries continue to work with the expanded schema and ignore the new tables.
There is no backfill or destructive reset. Existing SSH data and behavior are
unchanged. The configuration API stays unavailable until the feature is
explicitly enabled; merging this change does not enable it.

Before enabling the feature, every serving API version must include VNC-aware
deletion cleanup. Once any VNC configuration exists, that cleanup support is an
API rollback floor: disabling the feature does not erase saved credentials.
Rollback may disable `vncAccess`, but must retain VNC-aware cleanup and the additive
schema. Rolling back below this floor requires a separately verified drain and
erasure of all VNC configuration first.
Do not drop the tables as an application rollback. Runtime/Runner compatibility and activation belong
to #34980 and the remaining VNC delivery work.

## Verification

Route integration tests exercise auth, current membership, owner isolation,
rejoined owner access, secret-free output, validation, live-resource retries, recreation
after deletion, optimistic concurrency, rotation, inline rollback and scoped
cleanup through production HTTP boundaries.
The dedicated migration test validates database ownership and version/trust
constraints on a disposable schema. Broader API tests and required checks run
in the PR pipeline.
