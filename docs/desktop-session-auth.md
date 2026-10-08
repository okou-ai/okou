# Native Desktop session authentication

Native Desktop uses one API credential type: the current Clerk session token.
Clerk owns persistent login and JWT refresh. The API owns host identity,
connection admission, command ownership, and liveness. Helpers receive no token.

## Protocol

`computerUseSessionHostsContract` owns these additive API routes:

| Operation | POST path                                                      | Request authority                                            |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Register  | `/api/computer-use/hosts/register`                             | Verified Clerk session plus installation metadata            |
| Heartbeat | `/api/computer-use/hosts/:hostId/heartbeat`                    | Current session plus connection generation                   |
| Claim     | `/api/computer-use/hosts/:hostId/commands/next`                | Current session plus connection generation                   |
| Complete  | `/api/computer-use/hosts/:hostId/commands/:commandId/complete` | Current session plus the generation that claimed the command |
| Stop      | `/api/computer-use/hosts/:hostId/stop`                         | Current session plus connection generation                   |

Registration returns `{ hostId, connectionGeneration }`. Host IDs remain stable
for one user/organization/installation. Each registration advances the generation.
A stopped, replaced, revoked, or differently scoped connection cannot heartbeat,
claim, complete, or stop the replacement. Stop preserves chat-thread host bindings.
A refreshed JWT from the same Clerk session needs no registration. A different
session, even for the same user and organization, must register again.

Every request verifies the Clerk session token and its user/organization/session
binding. Non-session credentials are rejected by these execution routes; existing
CLI and Agent command creation retains its existing authorization contract.

## Provider freshness and recovery

Registration checks the live Clerk session and current organization membership.
Active hosts share the last successful provider validation for at most 30 seconds
across heartbeat, claim, completion, and stop. Validation is scoped to the current
host/session/generation and stamped before the provider reads, so provider latency
cannot extend its freshness. An inactive/missing session or removed membership
marks that connection offline. Failed provider reads propagate as a retryable 503
or 429 without extending validation; unrelated errors remain server failures.

Native SDK lookup, one forced refresh after 401, and HTTP share a total deadline.
Normal token expiration does not sign the user out. Temporary failures preserve
Keychain and retry. Identity monitoring runs independently of permission helper
failures and UI busy state. Late token results cannot cross identity generations.

The remote-revocation acceptance target is no new command dispatch within 60
seconds. The 30-second validation window, Native heartbeat/request budgets, and
pre-dispatch local admission checks support that target; verify it on a real Mac
against the actual Clerk environment before claiming production acceptance.
Already submitted macOS actions cannot be undone by a later revocation.

## Command completion

Local stop, workspace switch, sign-out, quit, and updates close admission, let
already claimed work finish within its existing command budget, report using the
current Clerk token, then stop the host and retire login. A late claim after local
admission closes is reported as not dispatched. Network and SDK retry only the
completion request, never the native action.

Remote revocation can deny completion. Keep the local execution result and an
explicit unconfirmed-report diagnostic; the server command reaches its existing
running-command timeout. A new generation cannot report the old command. No
additional completion credential or expired-token exception exists.

Claim and stop retain the existing bounded conditional-write model without
advisory locks. A request already racing with stop can still obtain a claim;
local generation/admission checks prevent dispatch after local stop. Remote
revocation has the bounded freshness window above, not instantaneous cancellation.

## Deployment order

1. Apply migration `1344_computer_use_session_auth` before promoting the expanded
   API. Nullable session fields and a default generation preserve legacy writes.
2. Fully deploy the session-capable API before releasing the new Native app.
   New Native against an older API stays offline with an actionable unavailable
   message; it never falls back to a host token.
3. Legacy Electron and already installed Native builds keep their original
   host-token routes during the upgrade window. Re-registering an installation
   using the new protocol invalidates its old host token. A legacy registration
   clears the Native session binding and supersedes that connection.
4. Retire the legacy routes and `token_hash` only after the replacement app is
   live, the Desktop version floor excludes old builds, and older serving and
   rollback API targets have drained. Remove legacy contracts/tests together.

| Client                          | Session-capable API                                | Earlier API                     |
| ------------------------------- | -------------------------------------------------- | ------------------------------- |
| New Native                      | Session protocol                                   | Offline; no credential fallback |
| Installed legacy Desktop/Native | Existing host-token protocol during upgrade window | Existing protocol               |

## Local acceptance

Build an isolated `Okou Dev` package against the local API using development
Clerk configuration. Exercise sign-in and organization selection, online/offline,
command completion, workspace switch, and sign-out. Keep a host idle and revoke
its Native Clerk session; also remove its organization membership. Verify the
60-second target and that the helper receives no subsequent action. Restore
membership or sign in again and explicitly reconnect. Test an outage followed by
recovery, a token refresh during a command, and a result denied after revocation.
Inspect the server command and Native diagnostics together; successful local
checks do not establish production deployment or real-Mac revocation acceptance.
