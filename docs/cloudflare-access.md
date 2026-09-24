# Cloudflare Access

Cloudflare Access is a Connector setting for reusable Personal or Organization
Service Tokens. Open **Connectors -> Private network** at
`/connectors?scope=private-network`. The Cloudflare Access card in the legacy
catalog opens that scope; the Connector Directory exposes it as the Private
network tab.

Cloudflare Access is not a directly usable Agent service. It has no Agent grant,
account picker, connector authorization, chat trigger, or direct command. A
consumer owns its own authorization. SSH is the first consumer and continues to
use the existing SSH Agent grant when a host selects a Cloudflare Access
configuration. Future consumers can reuse the same owner configuration without
making Cloudflare Access itself an Agent capability.

Configurations are either **Personal**, available only to their owner, or
**Organization**, available to every member of the current organization. Only
current organization admins can create, edit, or delete Organization
configurations. Members can select them for their own SSH hosts without seeing
the Service Token or other members' host metadata. The page has one Add action;
admins choose the scope in that dialog. SSH inline creation remains Personal.

Each configuration stores a display name and a Cloudflare Access Service Token
Client ID and Client Secret. Secrets are write-only. Use **Replace Service
Token** to rotate them; an ordinary rename does not submit secret fields. Create
requests use a client-generated resource ID so an explicit retry can safely
reuse the same request identity. Updates and deletion use the displayed revision,
and conflicts require reviewing the latest metadata. A configuration referenced
by an SSH host cannot be deleted until that host is rebound or deleted.

The canonical API is `/api/cloudflare-access/configs`; the Platform requests
`view=scoped` to list permitted Personal and Organization configurations. It
lists only the caller's SSH references as `sshHosts` while keeping the
configuration domain independent of SSH. Mutations and reconnect catch-up refresh Platform through
`cloudflare-access:changed` with `{ orgId }` only. The event never includes a
token, configuration ID, or host ID.

The SSH host form retains its Cloudflare Access selector and inline creation,
while configuration management lives in the **Private network** scope. Both flows read
and mutate the same canonical state. There is no feature switch, schema migration,
data copy, separate enabled state, or second set of records. The temporary
SSH-prefixed API and Access-only `ssh:changed` bridge were retired after the
canonical consumer was verified in production App `0.944.0`; see [deployment
compatibility](deployment-compatibility.md#cloudflare-access-for-ssh) for the
completed rollout boundary.

A protected SSH host whose shared configuration is no longer permitted can be
retained in a **needs rebind** state. It cannot connect and is never silently
changed to Direct. Its owner must edit the host and explicitly select another
permitted Cloudflare Access configuration or Direct. The host, credential, and
learned host key remain intact. Admin conversion that can create this state is
not available until the exact recovery-capable App build is verified in
production and the force-upgrade floor is applied in #36262.
