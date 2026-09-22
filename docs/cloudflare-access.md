# Cloudflare Access

Cloudflare Access is a standalone Connector setting for reusable, user-owned
Service Tokens. Open **Connectors -> Remote access -> Cloudflare Access** at
`/connectors/cloudflare-access`. In the Remote access category it follows SSH
and VNC.

Cloudflare Access is not a directly usable Agent service. It has no Agent grant,
account picker, connector authorization, chat trigger, or direct command. A
consumer owns its own authorization. SSH is the first consumer and continues to
use the existing SSH Agent grant when a host selects a Cloudflare Access
configuration. Future consumers can reuse the same owner configuration without
making Cloudflare Access itself an Agent capability.

Each configuration stores a display name and a Cloudflare Access Service Token
Client ID and Client Secret. Secrets are write-only. Use **Replace Service
Token** to rotate them; an ordinary rename does not submit secret fields. Create
requests use a client-generated resource ID so an explicit retry can safely
reuse the same request identity. Updates and deletion use the displayed revision,
and conflicts require reviewing the latest metadata. A configuration referenced
by an SSH host cannot be deleted until that host is rebound or deleted.

The canonical owner API is `/api/cloudflare-access/configs`. It lists current SSH
references as `sshHosts` while keeping the configuration domain independent of
SSH. Mutations and reconnect catch-up refresh Platform through
`cloudflare-access:changed` with `{ orgId }` only. The event never includes a
token, configuration ID, or host ID.

The SSH settings page intentionally retains its Cloudflare Access selector,
inline creation, and management UI during this rollout, but it reads and mutates
the same canonical state as the standalone page. There is no feature switch,
schema migration, data copy, separate enabled state, or second set of records.
The temporary SSH-prefixed API is only a deployment bridge for older Apps; see
[deployment compatibility](deployment-compatibility.md#cloudflare-access-for-ssh)
for its removal gate.
