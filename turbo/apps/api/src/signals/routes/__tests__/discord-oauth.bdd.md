# discord-oauth

## discord-oauth-001

- Vitest: "Discord product OAuth > installs the verified bot, connects the admin and welcomes only a newly committed connection"
- Mode: run
- Given: A signed-in org admin starts disconnected and status offers OAuth onboarding. Discord can verify the bot, guild and consenting account.
- When: The admin installs the bot through Discord OAuth, repeats installation, and reads status twice.
- Then: Status becomes connected with the expected guild, Discord user and admin access. Exactly one bot welcome introducing itself and asking for a task is sent on the first new connection.

## discord-oauth-002

- Vitest: "Discord product OAuth > installs when Discord returns only user scopes in the token and authorization"
- Mode: run
- Given: A signed-in admin starts installation OAuth. Discord will return only `identify` and `guilds` in both its user token and authorization evidence.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Start requests `bot applications.commands identify guilds` with guild install integration type 0, allowing guild choice. Completion returns HTTP 200 connected. Status reads back the expected Discord user and guild.

## discord-oauth-003

- Vitest: "Discord product OAuth > retains a completed personal grant when a later attempt reaps expired opener capabilities"
- Mode: run
- Given: A completed Discord install has already connected its owner and exposed one DM binding.
- When: After 601 seconds the owner starts another consent attempt, tries the old completion, then explicitly disconnects and retries the new pending completion. A different member subsequently authorizes the original Discord identity.
- Then: The completed binding survives expiry of the original opener capability with the same public DM binding. Old completion returns HTTP 400. Disconnect returns HTTP 200 and clears the connection. The pending completion returns HTTP 400 after disconnect. The other member can then connect the freed Discord identity.

## discord-oauth-004

- Vitest: "Discord product OAuth > connects from a server link without a workspace installation or server-management permission"
- Mode: run
- Given: A signed-in nonadmin workspace member follows a Discord server link. Their workspace has no installation and their Discord account is in the guild without server-management permission.
- When: The owner follows the OAuth callback, approval and completion.
- Then: OAuth requests only `identify guilds` without guild install permission or integration type. Completion connects the account without install-specific guild proof. Status reports connected and nonadmin.

## discord-oauth-005

- Vitest: "Discord product OAuth > lets an ordinary current org member connect only their verified Discord identity"
- Mode: run
- Given: An admin already installed and linked the bot, and another signed-in ordinary workspace member has their own verified Discord ID.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Account consent asks for `identify guilds` and connects the member's verified identity. Status exposes their member connection and preserves the admin's original identity.

## discord-oauth-006

- Vitest: "Discord product OAuth > allows ordinary workspace members to connect and rejects unauthenticated or malformed owner input"
- Mode: run
- Given: An ordinary member is signed in to a configured workspace, with no Discord connection.
- When: The member starts OAuth with no owner fields, submits an OAuth start with explicit arbitrary owner fields, and tries another start while unauthenticated.
- Then: The normal start returns HTTP 200. The request with supplied owner fields returns HTTP 400, and the signed-out start returns HTTP 401. Status remains disconnected.

## discord-oauth-007

- Vitest: "Discord product OAuth > allows account consent after an Okou admin becomes an ordinary workspace member"
- Mode: run
- Given: An Okou admin has begun a Discord OAuth flow but has become an ordinary workspace member before provider completion.
- When: The owner follows the OAuth callback, approval and completion.
- Then: The consenting account can still connect. Public status is connected.

## discord-oauth-008

- Vitest: "Discord product OAuth > starts account consent without a workspace installation and reports missing configuration"
- Mode: run
- Given: A signed-in member has no workspace installation and a guild link. The Discord app is available but its OAuth client secret can become unavailable.
- When: The member starts OAuth before and after the OAuth secret is removed.
- Then: The configured start returns HTTP 200. The next returns HTTP 503 `DISCORD_NOT_CONFIGURED`. Integration status still reports available.

## discord-oauth-009

- Vitest: "Discord product OAuth > rejects a forged well-formed state without consuming the genuine attempt"
- Mode: run
- Given: A valid signed-in owner has an open install attempt and a separate well-shaped but unissued state is supplied.
- When: The callback receives the unissued state before the owner completes their genuine attempt.
- Then: The first redirect says `invalid_state` and does not connect the owner. The genuine attempt still completes as connected.

## discord-oauth-010

- Vitest: "Discord product OAuth > bounds callback malformed-state before handling without consuming genuine state"
- Mode: run
- Given: A legitimate Discord install attempt is pending. A separate callback carries a malformed state value.
- When: The callback is submitted, then the owner completes the genuine attempt.
- Then: The malformed callback returns HTTP 400. The genuine attempt still connects.

## discord-oauth-011

- Vitest: "Discord product OAuth > bounds callback oversize-code before handling without consuming genuine state"
- Mode: run
- Given: A legitimate Discord install attempt is pending. A separate callback carries an authorization code one character over the 2,048-character limit.
- When: The callback is submitted, then the owner completes the genuine attempt.
- Then: The malformed callback returns HTTP 400. The genuine attempt still connects.

## discord-oauth-012

- Vitest: "Discord product OAuth > bounds callback oversize-error before handling without consuming genuine state"
- Mode: run
- Given: A legitimate Discord install attempt is pending. A separate callback carries an error value one character over the 128-character limit.
- When: The callback is submitted, then the owner completes the genuine attempt.
- Then: The malformed callback returns HTTP 400. The genuine attempt still connects.

## discord-oauth-013

- Vitest: "Discord product OAuth > rejects expired and reused state, and cancellation is one-use with no provider text"
- Mode: run
- Given: The owner has an expired OAuth state, a fresh attempt, and a separately valid install attempt.
- When: The owner invokes the expired callback, cancels the fresh attempt with provider-supplied detail, replays that cancelled callback, then completes and replays the valid attempt.
- Then: Expired state and either replay give `invalid_state`. The cancellation redirect reports `cancelled` without the provider detail and creates no connection or welcome. The valid attempt sends one welcome and its replay makes no second welcome.

## discord-oauth-014

- Vitest: "Discord product OAuth > fails closed for missing-token-identify-scope and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters a token that lacks the required identify scope.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-015

- Vitest: "Discord product OAuth > fails closed for missing-token-guilds-scope and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters a token that lacks the required guilds scope.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-016

- Vitest: "Discord product OAuth > fails closed for missing-authorization-identify-scope and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters authorization evidence missing identify even though the token has it.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-017

- Vitest: "Discord product OAuth > fails closed for missing-authorization-guilds-scope and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters authorization evidence missing guilds even though the token has it.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-018

- Vitest: "Discord product OAuth > fails closed for audience and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters an OAuth authorization for a different application audience.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-019

- Vitest: "Discord product OAuth > fails closed for identity and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters an authorization user who differs from the token's Discord user.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-020

- Vitest: "Discord product OAuth > fails closed for missing-guild-proof and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters missing guild proof.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-021

- Vitest: "Discord product OAuth > fails closed for selected-guild and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters proof for a guild other than the selected guild.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-022

- Vitest: "Discord product OAuth > fails closed for bot-audience and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters a live bot whose application audience differs from the configured app.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-023

- Vitest: "Discord product OAuth > fails closed for bot-missing and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters a bot no longer present in the guild.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-024

- Vitest: "Discord product OAuth > fails closed for provider-error and leaves status unchanged"
- Mode: run
- Given: A signed-in admin began install OAuth, but Discord verification encounters a provider token-exchange failure.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion reports an error, exposes no sensitive provider detail, leaves the account disconnected, and sends no welcome.

## discord-oauth-025

- Vitest: "Discord product OAuth > rejects a callback guild hint that disagrees with verified token guild evidence"
- Mode: run
- Given: The owner has an install attempt and Discord token exchange proves a specific guild.
- When: The OAuth callback also includes a guild hint for a different guild.
- Then: The redirect gives `guild_unverified` and user status stays disconnected.

## discord-oauth-026

- Vitest: "Discord product OAuth > revalidates revoked membership while authorization is open"
- Mode: run
- Given: An owner has begun Discord installation OAuth, but their Okou workspace membership is revoked while authorization is open.
- When: The owner follows the OAuth callback, approval and completion.
- Then: Completion fails and status still reports disconnected. No welcome is sent.

## discord-oauth-027

- Vitest: "Discord product OAuth > revalidates current membership again after slow provider work before callback writes"
- Mode: run
- Given: The owner begins Discord OAuth as a current member, but loses Okou membership during a provider guild membership request.
- When: The provider completes the lookup and the OAuth flow resumes.
- Then: The flow fails as `forbidden`, leaves the user disconnected, and sends no welcome.

## discord-oauth-028

- Vitest: "Discord product OAuth > paginates past 200 eligible guilds rather than silently truncating membership"
- Mode: run
- Given: Discord's first guild page contains 200 non-target guilds. The owner and bot are eligible in a later guild.
- When: The owner completes the normal installation flow.
- Then: Discord guild membership is paged beyond 200 and the connected status shows the target guild.

## discord-oauth-029

- Vitest: "Discord product OAuth > connects independent workspaces in the same server and preserves a connection when choosing another server"
- Mode: run
- Given: An owner has an installed Discord connection in a server. A member of another workspace has a different Discord user in that same server.
- When: The second workspace connects, and the original owner installs into a different Discord server.
- Then: Both remain connected. The original owner moves to the new guild while retaining the same personal connection ID. Two new personal welcomes occur in total.

## discord-oauth-030

- Vitest: "Discord product OAuth > rejects stealing a Discord identity in the same guild and across guilds"
- Mode: run
- Given: A connected Okou owner already controls a verified Discord identity.
- When: Another member attempts to connect that same identity in the same Discord server, and another workspace tries to claim it during installation into a different server.
- Then: Both attempts report `conflict` and remain disconnected. The first owner still has the original identity and only the first welcome has been sent.

## discord-oauth-031

- Vitest: "Discord product OAuth > requires disconnect before changing a user's Discord identity and releases unused ownership"
- Mode: run
- Given: An owner already has a connected Discord identity.
- When: The owner attempts to switch to another identity, explicitly disconnects, and a different workspace member then authorizes the released identity.
- Then: The switch reports `conflict`. The disconnect is HTTP 200 and clears the owner link. The next member connects the original verified Discord identity.

## discord-oauth-032

- Vitest: "Discord product OAuth > does not reserve a replacement Discord identity after an occupied-user binding fails"
- Mode: run
- Given: An Okou member already has a Discord connection and obtains approval for an OAuth attempt that would replace it without disconnecting.
- When: The owner completes the conflicting attempt twice, then a different owner legitimately installs using the proposed replacement Discord identity.
- Then: The conflicting attempt returns HTTP 409 and its replay HTTP 400. The first owner's identity stays the same. The different owner connects the unclaimed replacement identity and its guild. Exactly two welcomes exist across the successful connections.

## discord-oauth-033

- Vitest: "Discord product OAuth > keeps separate attempts correlated to independent consent and completion proofs"
- Mode: run
- Given: One owner has two independent Discord install attempts in the same guild, each with its own verified landing page and opener proof.
- When: The owner cross-uses the approval proof and completion token, then uses each attempt's corresponding proofs.
- Then: The foreign approval is HTTP 400 and preapproval completion HTTP 409. A foreign completion token is HTTP 400. The two original approval and completion pairs succeed with HTTP 200 and create just one welcome.

## discord-oauth-034

- Vitest: "Discord product OAuth > connects different users in different workspaces concurrently through the same server"
- Mode: run
- Given: Two distinct users from separate workspaces start installation in the same Discord server and authorize two different Discord identities.
- When: The two members complete the legitimate attempts concurrently.
- Then: Both report connected, each member reads their own connected status, and two welcomes are sent.

## discord-oauth-035

- Vitest: "Discord product OAuth > keeps one account connection when the same owner connects from two servers concurrently"
- Mode: run
- Given: The same owner and Discord identity have two verified, approved install attempts for separate servers.
- When: The owner completes them concurrently, reconnects to the original guild, and replays both old attempts.
- Then: Both concurrent completions are HTTP 200 connected. Public status has one DM binding and one welcome. Reconnection can select the original guild without changing the binding ID or repeating the welcome, and each consumed attempt returns HTTP 400.

## discord-oauth-036

- Vitest: "Discord product OAuth > installs into an invite's server while preserving the existing account connection"
- Mode: run
- Given: A connected Discord owner opens an invite that explicitly targets a different guild.
- When: The owner starts targeted install and finishes while the provider verifies that guild.
- Then: The provider URL pins the invite guild, disables guild selection, and requests bot scope with guild install type 0. Connection succeeds in the new guild and retains the same Discord user and DM connection IDs without another welcome.

## discord-oauth-037

- Vitest: "Discord product OAuth > rejects a different installed server than the invite target and keeps the old connection"
- Mode: run
- Given: A connected Discord owner explicitly targets a new guild with an invite, but Discord verifies an installation in a third guild instead.
- When: The owner completes the invite OAuth grant.
- Then: The attempt reports an error and public status stays exactly as it was beforehand.

## discord-oauth-038

- Vitest: "Discord product OAuth > allows only one account to win concurrent Discord identity claims across guilds in same workspace"
- Mode: run
- Given: Two separate users in the same Okou workspace have approved installation attempts for the same Discord identity in different guilds.
- When: The owners complete concurrently and then replay both attempts.
- Then: One completion returns HTTP 200 and the other HTTP 409 `CONFLICT`. Only the winning user's status is connected, one welcome is sent, and both consumed attempts return HTTP 400 on replay.

## discord-oauth-039

- Vitest: "Discord product OAuth > allows only one account to win concurrent Discord identity claims across guilds in different workspaces"
- Mode: run
- Given: Two separate users in different Okou workspaces have approved installation attempts for the same Discord identity in different guilds.
- When: The owners complete concurrently and then replay both attempts.
- Then: One completion returns HTTP 200 and the other HTTP 409 `CONFLICT`. Only the winning user's status is connected, one welcome is sent, and both consumed attempts return HTTP 400 on replay.

## discord-oauth-040

- Vitest: "Discord product OAuth > does not reserve the losing identity when two verified senders race for one workspace member"
- Mode: run
- Given: An installed guild permits member OAuth, and one Okou workspace member has pending attempts for two different verified Discord users.
- When: Both attempts complete concurrently. A different account then tries the losing Discord identity in another guild.
- Then: The first member gets one connected attempt and one error, and the losing attempt returns HTTP 400 on replay. The first member stays bound to the winning Discord identity. The other account can connect the losing identity and retain its own installation. Three new-connection welcomes occur including the initial admin.

## discord-oauth-041

- Vitest: "Discord product OAuth > commits one connection and welcome for simultaneous legitimate same-owner attempts"
- Mode: run
- Given: One owner has two legitimate install attempts for the same Discord account and guild.
- When: Both flows complete concurrently.
- Then: Both report connected and status is connected, while the provider receives one welcome.

## discord-oauth-042

- Vitest: "Discord product OAuth > rejects a concurrent replay of the same provider state before a second write or welcome"
- Mode: run
- Given: A single legitimately started install attempt has one provider OAuth state.
- When: Two requests try to finish that same attempt concurrently.
- Then: One reports connected and one reports error. Status is connected and there is one welcome.

## discord-oauth-043

- Vitest: "Discord product OAuth > does not reconnect an account from a pending attempt after disconnect"
- Mode: run
- Given: An installed Discord account has an open reconnect attempt.
- When: The account owner disconnects through the public integration API before the attempt returns, then tries to finish it.
- Then: Disconnect returns HTTP 200. Completion fails with `invalid_state`, status is disconnected, and no welcome is added to the installation's original one.

## discord-oauth-044

- Vitest: "Discord product OAuth > authorizes the exact DM recipient independently before a welcome, without undoing connection"
- Mode: run
- Given: Discord can verify the OAuth account but returns a created DM channel whose recipient is a different Discord user.
- When: The owner installs and retries the same legitimate installation flow.
- Then: The verified connection succeeds and public status is connected. The bot sends no welcome to the mismatched DM on either attempt.

## discord-oauth-045

- Vitest: "Discord product OAuth > neither the anonymous callback nor approval binds; only approved owner completion binds once"
- Mode: run
- Given: A signed-in owner starts Discord OAuth for a guild but has not approved the verified provider result.
- When: The owner tries completion before and after the browser's anonymous OAuth callback, then tries it after approval and repeats approval and completion.
- Then: Before approval, completion is HTTP 409. The anonymous landing reports pending and its verified guild; neither landing nor approval connects the account or sends a welcome. First approval is HTTP 200, replay HTTP 400. First completion is HTTP 200 and replay HTTP 400. The owner then reads connected and sees one welcome.

## discord-oauth-046

- Vitest: "Discord product OAuth > rejects attacker-start/victim-consent different-account without granting the attacker access"
- Mode: run
- Given: A verified Discord attempt belongs to the initiating Okou account and workspace. The browser's active consent session is a different user in the same workspace.
- When: The active session attempts approval and completion, and the initiator tries completion without valid approval.
- Then: Approval and completion from the mismatched session return HTTP 403, and the initiator's completion is HTTP 409. Both statuses stay disconnected and no welcome is sent.

## discord-oauth-047

- Vitest: "Discord product OAuth > rejects attacker-start/victim-consent different-org without granting the attacker access"
- Mode: run
- Given: A verified Discord attempt belongs to the initiating Okou account and workspace. The browser's active consent session is the same Okou user in a different workspace.
- When: The active session attempts approval and completion, and the initiator tries completion without valid approval.
- Then: Approval and completion from the mismatched session return HTTP 403, and the initiator's completion is HTTP 409. Both statuses stay disconnected and no welcome is sent.

## discord-oauth-048

- Vitest: "Discord product OAuth > revalidates member-before-approve after provider verification"
- Mode: run
- Given: Discord has verified the grant but the owner loses their Okou membership before approval.
- When: The owner submits the next stage of the legitimate OAuth flow.
- Then: The stage returns HTTP 403, status remains disconnected, and no welcome is sent.

## discord-oauth-049

- Vitest: "Discord product OAuth > revalidates member-before-complete after provider verification"
- Mode: run
- Given: Discord has verified the grant but the owner loses their Okou membership after approval and before completion.
- When: The owner submits the next stage of the legitimate OAuth flow.
- Then: The stage returns HTTP 403, status remains disconnected, and no welcome is sent.

## discord-oauth-050

- Vitest: "Discord product OAuth > rechecks live bot-gone after approval before any write"
- Mode: run
- Given: An installation attempt has already been verified and approved. Before completion, Discord's current evidence changes: the bot has left the guild.
- When: The owner submits completion, requiring live Discord verification.
- Then: The API returns HTTP 503, creates no connection, and sends no welcome.

## discord-oauth-051

- Vitest: "Discord product OAuth > rechecks live sender-gone after approval before any write"
- Mode: run
- Given: An installation attempt has already been verified and approved. Before completion, Discord's current evidence changes: the consenting sender is no longer a guild member.
- When: The owner submits completion, requiring live Discord verification.
- Then: The API returns HTTP 503, creates no connection, and sends no welcome.

## discord-oauth-052

- Vitest: "Discord product OAuth > rechecks live bot-replaced after approval before any write"
- Mode: run
- Given: An installation attempt has already been verified and approved. Before completion, Discord's current evidence changes: the live bot belongs to a different application.
- When: The owner submits completion, requiring live Discord verification.
- Then: The API returns HTTP 503, creates no connection, and sends no welcome.

## discord-oauth-053

- Vitest: "Discord product OAuth > rechecks live guild-admin-revoked after approval before any write"
- Mode: run
- Given: An installation attempt has already been verified and approved. Before completion, Discord's current evidence changes: the consenting user no longer has guild administrator authority.
- When: The owner submits completion, requiring live Discord verification.
- Then: The API returns HTTP 503, creates no connection, and sends no welcome.

## discord-oauth-054

- Vitest: "Discord product OAuth > rechecks Clerk authorization after slow native provider work during completion"
- Mode: run
- Given: A Discord install attempt already has verified evidence and approval, but the owner loses Okou membership during the live provider lookup at completion.
- When: The owner submits completion and the provider returns its result.
- Then: Completion returns HTTP 403, status stays disconnected, and no welcome is sent.

## discord-oauth-055

- Vitest: "Discord product OAuth > does not extend original expiry for verified evidence"
- Mode: run
- Given: The owner has a Discord install attempt with verified but unapproved evidence. More than 600 seconds have elapsed since OAuth start.
- When: The owner attempts approval and completion.
- Then: Both requests are HTTP 400. Neither the verification nor approval extended expiry, the owner remains disconnected, and there is no welcome.

## discord-oauth-056

- Vitest: "Discord product OAuth > does not extend original expiry for approved evidence"
- Mode: run
- Given: The owner has a Discord install attempt with verified and approved evidence. More than 600 seconds have elapsed since OAuth start.
- When: The owner attempts approval and completion.
- Then: Both requests are HTTP 400. Neither the verification nor approval extended expiry, the owner remains disconnected, and there is no welcome.

## discord-oauth-057

- Vitest: "Discord product OAuth > atomically consumes concurrent approvals and concurrent completions once"
- Mode: run
- Given: The owner has one valid verified Discord attempt with reusable-looking copies of its same approval and completion data.
- When: The owner submits duplicate approvals concurrently, then duplicate completions concurrently.
- Then: Each pair yields one HTTP 200 and one HTTP 400. Public status is connected and the bot sends exactly one welcome.

## discord-oauth-058

- Vitest: "Discord product OAuth > does not grant access from query markers, lost opener proof or malformed capabilities"
- Mode: run
- Given: An owner has an OAuth attempt with a provider verification landing, but tries to substitute a completion token for an approval proof, use a different completion token, or proceed without the opener's valid credentials.
- When: The owner calls approve and complete with mismatched or malformed credentials, including a request that supplies only state and an installed query marker.
- Then: Each malformed or unauthorized capability request returns HTTP 400. The owner remains disconnected and Discord receives no welcome.

## discord-oauth-059

- Vitest: "Discord product OAuth > preserves a same-owner new-guild connection during concurrent last-old-guild disconnect using only public OAuth and provider gates"
- Mode: run
- Given: The same Okou user controls an existing Discord binding in one workspace and has approved a new link into an already installed second guild. During completion, Discord's live member lookup is still pending.
- When: The user disconnects the last old-guild binding while the new-guild completion is waiting, and the lookup then succeeds. The sequence is repeated after releasing the second guild and reconnecting the first.
- Then: The overlapping completion and disconnect both return HTTP 200. Old-workspace status is disconnected while the second workspace reads as connected to the expected new guild and same Discord identity. Releasing the new connection allows the original one to connect again.

## discord-oauth-060

- Vitest: "Discord product OAuth > excludes actual callback query and approval Location from real OTel spans while preserving provider query handling and other request tracing"
- Mode: run
- Given: Discord OAuth start, provider callback, approval, and completion run with an OpenTelemetry exporter observing finished spans.
- When: The owner completes a legitimate install using the actual provider callback code and approval landing.
- Then: Callback returns a usable pending landing, approval and completion return HTTP 200, and status is connected. Exported spans include OAuth start and successful request tracing but no callback span and no raw state, completion token, approval proof, provider code, or landing URL in span fields.
