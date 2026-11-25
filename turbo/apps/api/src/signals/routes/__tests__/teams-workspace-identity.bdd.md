# teams-workspace-identity

## teams-workspace-identity-001

- Vitest: "oauth connection sends one personal welcome using the verified AAD identity"
- Mode: run
- Given: A Teams workspace admin installs the bot using the provider's install flow. The verified account profile has an Entra object ID and name.
- When: The admin connects their personal Teams account through Microsoft OAuth, then reconnects that same account.
- Then: Installation alone sends no welcome. The first connected account creates one nongroup Teams conversation addressed to the verified object ID and name in its tenant and delivers one `You're connected to Okou!` welcome. Reconnection delivers no second welcome.

## teams-workspace-identity-002

- Vitest: "an account connected before bot installation receives its pending DM welcome once the bot is ready"
- Mode: run
- Given: A Teams workspace admin connects through Microsoft OAuth before installing the bot.
- When: The admin finishes installation and Teams sends a bot-installed event twice.
- Then: No welcome is sent before installation. The first event produces one pending personal welcome, and duplicate install notification leaves the count at one.

## teams-workspace-identity-003

- Vitest: "a rejected Teams welcome remains pending without failing or duplicating the connection"
- Mode: run
- Given: A workspace admin installs the Teams bot and then connects a verified personal account. Teams refuses its first welcome activity with HTTP 403.
- When: Teams later sends an installation event when delivery is available, and the admin reconnects the same account.
- Then: The initial OAuth still succeeds and account status reports connected after exactly one failed welcome attempt. The installation event delivers only the pending welcome and the user has one created personal conversation. Reconnection makes no duplicate welcome.

## teams-workspace-identity-004

- Vitest: "connecting an identity never borrows another workspace's bot for a welcome DM"
- Mode: run
- Given: An admin installed a bot for their own workspace, and another workspace has no installation of that bot.
- When: An external member connects their verified Microsoft identity for the same Teams tenant through OAuth.
- Then: The external connection succeeds. No personal conversation or welcome message uses the other workspace's bot.

## teams-workspace-identity-005

- Vitest: "a member connects an OAuth identity before installation and can disconnect it"
- Mode: run
- Given: A nonadmin member starts with no Teams installation or linked identity.
- When: They complete Microsoft OAuth for their account, read Teams status, and call `DELETE /api/integrations/teams/connect` to disconnect.
- Then: Status initially shows workspace identity, one linked tenant and Entra identity, connected and not installed, with no install URL or admin action. Disconnect returns HTTP 200 and status then shows no connection or installation and an available connect URL.

## teams-workspace-identity-006

- Vitest: "connecting to an installed tenant leaves bot ownership with its original organization"
- Mode: run
- Given: An organization owns an installed, connected Teams bot. A member of another organization has a distinct Microsoft identity in the same Teams tenant.
- When: The external member connects through OAuth and attempts a native Teams send to the existing bot's conversation using their web session. Both organizations read their status.
- Then: The external member is connected without an installation and the send is HTTP 404. The original organization still reports both installed and connected.

## teams-workspace-identity-007

- Vitest: "raw identity payloads cannot create an independent account connection"
- Mode: run
- Given: A signed-in member has no linked identity and holds caller-supplied tenant, Teams user and Entra identifiers.
- When: They submit those values to `POST /api/integrations/teams/connect` and also open the browser connect URL with raw tenant and user parameters.
- Then: The direct account write is HTTP 403. The browser request is HTTP 307 to `/api/teams/oauth/connect` and status still reports disconnected.

## teams-workspace-identity-008

- Vitest: "another user cannot take an OAuth identity and account changes require disconnect"
- Mode: run
- Given: A member has already linked a Microsoft Entra identity to their Okou account and organization.
- When: Another user and the owner under a different organization each try to connect that identity. The original owner also tries a different Microsoft identity, then disconnects through the API and connects again with a new account.
- Then: All three conflicting callbacks direct the user to disconnect first, and the original public account retains its Entra identity. The explicit disconnect returns HTTP 200, after which OAuth succeeds and status shows the new identity.

## teams-workspace-identity-009

- Vitest: "an administrator installs the bot separately and uninstall preserves the OAuth identity"
- Mode: run
- Given: A workspace admin has linked their verified personal Teams account, independently of the bot installation identity.
- When: They complete the installation OAuth flow, install the bot, read current status, and issue `DELETE /api/integrations/teams/connect?action=uninstall`.
- Then: The installation flow returns a Microsoft Teams link and status becomes connected and installed. Uninstall is HTTP 200. The bot is gone from status but the same personal Entra account remains connected.

## teams-workspace-identity-010

- Vitest: "a receiving organization's bot preserves the user's own execution organization (access)"
- Mode: run
- Given: A receiving organization's Teams bot accepts a signed mention by an external member with a verified Teams identity linked to their own organization. Teams confirms the member remains in that conversation and the Runner receives a run-scoped native token.
- When: The Runner sends to the source conversation, tries an unrelated conversation and DM, and retries the authorized destination after membership is revoked. After membership returns it prepares and uploads a canonical report with a pinned message, tries completion first without and then with membership while supplying replacement destination and text, and replays an uncertain send and a delivered report after account disconnect.
- Then: The ingress is HTTP 200, the sender's own organization has the only running entry, and the receiving organization gets HTTP 404 reading it. One source send succeeds and includes the triggering sender attribution. Other destinations and a revoked member get HTTP 404. The pinned report completion returns HTTP 404 until membership is restored, then sends exactly one report with the originally pinned destination and caption. The uncertain send returns HTTP 409 twice with just one provider attempt. After disconnect the completed upload still returns the same HTTP 200 receipt and is not sent again.

## teams-workspace-identity-011

- Vitest: "a receiving organization's bot preserves the user's own execution organization (callback)"
- Mode: run
- Given: A receiving organization's bot accepted an external linked member's mention, creating a running entry in the member's own organization. Teams still verifies the member's source conversation access.
- When: The Runner posts a failed completion with its sandbox token.
- Then: The completion returns HTTP 200 and the bot sends the generic `Oops, something went wrong. Please try again later.` message into the source conversation. The receiving organization cannot read the member's run.

## teams-workspace-identity-012

- Vitest: "a receiving organization's bot preserves the user's own execution organization (callback-left)"
- Mode: run
- Given: A receiving organization's bot accepted an external linked member's message and the run belongs to that member's own organization. Teams now reports the member has left the conversation.
- When: The Runner posts a failed completion with its sandbox token.
- Then: The callback returns HTTP 200 and Teams gets no new message for the revoked conversation. The receiving organization cannot read the member's run.

## teams-workspace-identity-013

- Vitest: "a receiving organization's bot preserves the user's own execution organization (probe-unavailable)"
- Mode: run
- Given: A receiving organization's bot receives a signed mention from an external member linked in their own organization, but Teams returns HTTP 503 for the membership probe.
- When: The member sends a mention while the probe is unavailable and a second mention after the provider becomes reachable.
- Then: The first request returns HTTP 200 without any outbound message or run. The recovered probe permits one running Teams entry in the member's own organization, and the receiving organization gets HTTP 404 reading it.

## teams-workspace-identity-014

- Vitest: "organizationMembership.deleted releases Teams account authority"
- Mode: run
- Given: A workspace admin has an existing verified Teams OAuth account for a tenant and Entra identity.
- When: Clerk delivers the verified `organizationMembership.deleted` webhook to `POST /api/webhooks/clerk`. A different workspace admin then completes OAuth with the same Teams identity.
- Then: The webhook returns HTTP 200. The next OAuth succeeds and its authenticated status reports connected with no installation.

## teams-workspace-identity-015

- Vitest: "organization.deleted releases Teams account authority"
- Mode: run
- Given: A workspace admin has an existing verified Teams OAuth account for a tenant and Entra identity.
- When: Clerk delivers the verified `organization.deleted` webhook to `POST /api/webhooks/clerk`. A different workspace admin then completes OAuth with the same Teams identity.
- Then: The webhook returns HTTP 200. The next OAuth succeeds and its authenticated status reports connected with no installation.

## teams-workspace-identity-016

- Vitest: "user.deleted releases Teams account authority"
- Mode: run
- Given: A workspace admin has an existing verified Teams OAuth account for a tenant and Entra identity.
- When: Clerk delivers the verified `user.deleted` webhook to `POST /api/webhooks/clerk`. A different workspace admin then completes OAuth with the same Teams identity.
- Then: The webhook returns HTTP 200. The next OAuth succeeds and its authenticated status reports connected with no installation.
