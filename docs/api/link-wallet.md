# Link wallet ownership

A Link authorization belongs to one workspace and one user. All of that user's
active, user-initiated web-chat runs in that workspace use the same authorization.
Other users and workspaces remain isolated. Settings > Billing & pricing > Wallet
is available to members and admins when both `LinkWallet` and `WalletSettings`
are enabled, and manages the current user's connection through session-only
endpoints. `WalletSettings` (`walletSettings`) defaults to staff workspaces only;
turning it off hides the menu and its deep link and skips the Settings wallet
subscription. Session and run wallet endpoints retain the `LinkWallet` gate.

Reconnect starts a new hosted consent without disconnecting the current wallet.
The existing authorization remains usable if that consent is canceled or declined;
successful consent replaces it. Settings distinguishes an expired connection from
changed permissions and reuses the connector permission-review dialog before
reconnecting. Agent-scoped grants require explicit approval of workspace/user
sharing. Grants without a permission snapshot require a fresh review.

Migration `1401_link_wallet_scope_snapshots` adds nullable request-snapshot fields
to OAuth attempts and connections. Capture the requested scopes when consent starts
and copy that exact snapshot on callback; token refresh must preserve it. This
keeps a callback issued before a scope change from claiming approval of the newer
permissions. Existing rows remain null instead of being backfilled as authorized.

Connection management does not permit spending. Purchase endpoints still require
an active interactive run with `wallet:write`; every purchase needs separate Link
approval. A spend retains its originating agent, immutable intent details, and
exact authorization ID. Another agent cannot retrieve its approval or credentials,
and reconnecting never moves an existing purchase onto a replacement grant.

## Consent migration and deployment

Migration `1400_cuddly_doctor_faustus` is additive: it permits a null agent on
connections and OAuth attempts, retains the old agent-scoped unique index, adds a
partial workspace/user unique index for shared connections, and defaults attempt
scope to `agent` for outgoing API writers. It does not copy, merge, broaden, delete,
or decrypt existing grants or purchase requests.

Users with old agent-scoped consent must Connect again to authorize the workspace
scope. New attempts explicitly use `workspace_user`; their optional agent ID is
chat provenance, and their published connection always has a null agent ID.
Pre-deployment callbacks retain their original agent scope. Old purchase requests
remain stored but cannot be used with the new authorization; uncertain payments
must be checked before the user approves any new purchase.

Apply the database migration, promote the API, then publish the App. Outgoing API
writers can still upsert their original agent-scoped rows. On API rollback, shared
authorizations remain stored but the outgoing API cannot use them; users may need
to reconnect after rolling forward. Do not contract the legacy columns/index or
remove old grants as part of rollback.

Disconnect cancels pending consent for that workspace/user and disables all their
shared and legacy grants locally before provider revocation. Failed provider
revocation retains encrypted material for retry, and Settings keeps Disconnect
available while revocation is unconfirmed. Existing chat clients still receive
agent-origin notifications; current clients also filter by workspace.

The focused migration regression is `pnpm -F @okouai/db test:link-wallet-workspace-owner`
with a local test `DATABASE_URL`. It checks retained consent, outgoing conflict
writers, workspace/user uniqueness and isolation, and shared-grant survival after
agent deletion.
