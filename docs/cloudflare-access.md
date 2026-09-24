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
Token** to rotate them; an ordinary rename does not submit secret fields. An admin can also promote
**their own** Personal configuration to Organization in place after an audience
confirmation; its ID, encrypted Service Token, and existing SSH bindings stay
unchanged. Other admins cannot promote someone else's Personal row, and
members cannot change scope. Create
requests use a client-generated resource ID so an explicit retry can safely
reuse the same request identity. Updates and deletion use the displayed revision,
and conflicts require reviewing the latest metadata. A configuration cannot be deleted while any of **your own** SSH hosts reference
it: first rebind or delete those hosts. An admin deleting an Organization
configuration referenced only by other members' SSH hosts must review a
per-owner name/ID and host-count preview and explicitly confirm the impact.
Names unavailable for a former member are identified by stable user ID. The
server checks the revision, exact reference snapshot, and absence of the
admin's own host references again in the deletion transaction; an unreviewed
or changed impact is rejected. Other members' hosts remain saved as
`needs_rebind` with credentials and host-key pins intact, never switched to
Direct automatically. Their owners must explicitly rebind them before a new
SSH connection can use them. No notification is sent to affected members.
An already-running Run is not cancelled or invalidated and may continue using
its cached SSH authority until it finishes; subsequent resolutions respect
`needs_rebind`.

The canonical API is `/api/cloudflare-access/configs`; the Platform requests
`view=scoped` to list permitted Personal and Organization configurations. It
lists only the caller's SSH references as `sshHosts` while keeping the
configuration domain independent of SSH. Mutations and reconnect catch-up refresh Platform through
`cloudflare-access:changed` with `{ orgId }` only. The event never includes a
token, configuration ID, or host ID.

The SSH host form retains its Cloudflare Access selector and inline creation,
while configuration management lives in the **Private network** scope. Both flows read
and mutate the same canonical state. There is no feature switch, data copy, separate enabled state, or second set of
records. The scope guard migration for Personal-to-Organization promotion must
run before the new API operation is enabled. The temporary
SSH-prefixed API and Access-only `ssh:changed` bridge were retired after the
canonical consumer was verified in production App `0.944.0`; see [deployment
compatibility](deployment-compatibility.md#cloudflare-access-for-ssh) for the
completed rollout boundary.

A protected SSH host whose shared configuration is no longer permitted can be
retained in a **needs rebind** state. It cannot connect and is never silently
changed to Direct. Its owner must edit the host and explicitly select another
permitted Cloudflare Access configuration or Direct. The host, credential, and
learned host key remain intact. An organization admin can convert a shared
configuration to Personal after reviewing its current impact. The preview
reports only the count of other members' referencing SSH hosts; their names and
owners are never shown. When that count is positive, the admin must explicitly
confirm that those hosts will need to be rebound. A changed revision or impact
requires another review. Conversion retains the Access ID and stored Service
Token. The admin's own hosts remain bound, while other members' hosts remain
saved in needs-rebind state until their owners explicitly choose a permitted
configuration or Direct. A saved VNC connection using such an SSH host remains
visible to its owner with a rebind warning; fresh VNC Run inventories omit it
until the SSH host is repaired, and fresh VNC Runner resolve/check calls return
unavailable before releasing VNC credentials. The VNC route is never switched
to Direct automatically. Already-running Runs may retain previously cached SSH
authority until completion as described above.
