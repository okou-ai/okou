# integrations-discord

## integrations-discord-001

- Vitest: "Discord server installation links > resolves https://discord.gg/example without an existing binding or provider credentials"
- Mode: run
- Given: A signed-in workspace admin has no Discord binding, `APP_URL` is `https://preview-app.example`, and Discord's public invite lookup for code `example` returns a non-expiring guild invite for guild 1559819014036000790 "New server".
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.gg/example`.
- Then: The response is HTTP 200 with exactly `{ url: "https://preview-app.example/settings/discord/install?guild_id=1559819014036000790", guildId, guildName: "New server" }`. Discord receives exactly one GET invite lookup with no authorization header and `with_expiration=true`. No `discord:changed` realtime event is published.

## integrations-discord-002

- Vitest: "Discord server installation links > resolves https://discord.com/invite/example?utm_source=share without an existing binding or provider credentials"
- Mode: run
- Given: A signed-in workspace admin has no Discord binding, `APP_URL` is `https://preview-app.example`, and Discord's public invite lookup for code `example` returns a non-expiring guild invite for guild 1559819014036000790 "New server".
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.com/invite/example?utm_source=share`.
- Then: The response is HTTP 200 with exactly `{ url: "https://preview-app.example/settings/discord/install?guild_id=1559819014036000790", guildId, guildName: "New server" }`. Discord receives exactly one GET invite lookup with no authorization header and `with_expiration=true`. No `discord:changed` realtime event is published.

## integrations-discord-003

- Vitest: "Discord server installation links > resolves https://discordapp.com/invite/example/ without an existing binding or provider credentials"
- Mode: run
- Given: A signed-in workspace admin has no Discord binding, `APP_URL` is `https://preview-app.example`, and Discord's public invite lookup for code `example` returns a non-expiring guild invite for guild 1559819014036000790 "New server".
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discordapp.com/invite/example/`.
- Then: The response is HTTP 200 with exactly `{ url: "https://preview-app.example/settings/discord/install?guild_id=1559819014036000790", guildId, guildName: "New server" }`. Discord receives exactly one GET invite lookup with no authorization header and `with_expiration=true`. No `discord:changed` realtime event is published.

## integrations-discord-004

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://attacker.example/invite/example"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://attacker.example/invite/example`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-005

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://discord.gg.attacker.example/example"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.gg.attacker.example/example`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-006

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://discord.gg@attacker.example/example"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.gg@attacker.example/example`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-007

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: http://discord.gg/example"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with the non-HTTPS invite `http://discord.gg/example`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-008

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://discord.gg:444/example"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.gg:444/example` (non-default port).
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-009

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://discord.gg/example/another"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with invite `https://discord.gg/example/another` (extra path segment).
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-010

- Vitest: "Discord server installation links > rejects an unsupported URL without fetching it: https://discord.com/channels/123"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin calls `POST /api/integrations/discord/install-link` with the channel URL `https://discord.com/channels/123`.
- Then: The response is HTTP 400 with error code `BAD_REQUEST`.

## integrations-discord-011

- Vitest: "Discord server installation links > handles provider status 404 as 404"
- Mode: run
- Given: A signed-in workspace admin, and Discord's invite lookup for `example` returns HTTP 404.
- When: The admin calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example`.
- Then: The response status is 404.

## integrations-discord-012

- Vitest: "Discord server installation links > handles provider status 200 as 400"
- Mode: run
- Given: A signed-in workspace admin, and Discord's invite lookup returns HTTP 200 with a non-guild invite (`type: 1`).
- When: The admin calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example`.
- Then: The response status is 400.

## integrations-discord-013

- Vitest: "Discord server installation links > handles provider status 200 as 404"
- Mode: run
- Given: A signed-in workspace admin, and Discord's invite lookup returns HTTP 200 with a guild invite that expired at 2020-01-01T00:00:00Z.
- When: The admin calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example`.
- Then: The response status is 404.

## integrations-discord-014

- Vitest: "Discord server installation links > handles provider status 429 as 429"
- Mode: run
- Given: A signed-in workspace admin, and Discord's invite lookup returns HTTP 429 with `retry_after: 5`.
- When: The admin calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example`.
- Then: The response status is 429.

## integrations-discord-015

- Vitest: "Discord server installation links > handles provider status 500 as 502"
- Mode: run
- Given: A signed-in workspace admin, and Discord's invite lookup returns HTTP 500.
- When: The admin calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example`.
- Then: The response status is 502.

## integrations-discord-016

- Vitest: "Discord server installation links > requires authentication"
- Mode: run
- Given: The caller is unauthenticated.
- When: The caller calls `POST /api/integrations/discord/install-link` with `https://discord.gg/example` and no authorization header.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## integrations-discord-017

- Vitest: "Discord installation link run access > grants a run Discord installation link access without requiring a server binding"
- Mode: run
- Given: A workspace admin with no Discord server binding launches a web run, and Discord's invite lookup returns a guild invite for "New server".
- When: The run calls `POST /api/integrations/discord/install-link` with its run token and invite `https://discord.gg/example`.
- Then: The run's appended system prompt does not contain "okou discord install-link". The install-link request returns HTTP 200.

## integrations-discord-018

- Vitest: "verified Discord integration settings > requires authenticated organization membership"
- Mode: run
- Given: The caller is unauthenticated, or signed in without an active organization.
- When: The unauthenticated caller requests `GET /api/integrations/discord`, `DELETE /api/integrations/discord` and `PUT /api/integrations/discord/dm-selection`; the organization-less session requests `GET /api/integrations/discord`.
- Then: Every request returns HTTP 401, and no `discord:changed` realtime event is published.

## integrations-discord-019

- Vitest: "verified Discord integration settings > reports existing bindings and unavailable context when app configuration is missing"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot in a guild, but the Discord bot token is no longer configured.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status reports `isAvailable: false`, `isConnected: true`, the installed `guildId`, `contextMode` "unavailable", `onboarding` "oauth" and an empty `dmBindings` list.

## integrations-discord-020

- Vitest: "verified Discord integration settings > reports verified guild identity and honest MESSAGE_CONTENT availability"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot in guild "Customer workspace", and Discord reports the application with no message-content flags.
- When: The admin requests `GET /api/integrations/discord`, then Discord reports the application with flag `1 << 18` and the admin requests the status again.
- Then: The first status is exactly `isAvailable: true`, `isConnected: true`, `isAdmin: true`, the guild ID, `guildName` "Customer workspace", the linked `discordUserId`, `contextMode` "mentions_only", `onboarding` "oauth", `dmSelectionConnectionId` null, and one DM binding with the connection ID, guild ID, guild name and workspace name "Discord test workspace". The second status has `contextMode` "full".

## integrations-discord-021

- Vitest: "verified Discord integration settings > reports full context for Discord's actual grant 524288/undefined"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord reports the application with `flags` 524288 (`1 << 19`) and no `flags_new`.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "full".

## integrations-discord-022

- Vitest: "verified Discord integration settings > reports full context for Discord's actual grant 0/1099511889920"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord reports the application with `flags` 0 and `flags_new` "1099511889920" (bits 40 and 18).
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "full".

## integrations-discord-023

- Vitest: "verified Discord integration settings > reports full context for Discord's actual grant 0/524288"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord reports the application with `flags` 0 and `flags_new` "524288" (bit 19).
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "full".

## integrations-discord-024

- Vitest: "verified Discord integration settings > reports mentions-only when the authoritative flags do not grant content"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord reports the configured application with `flags` `1 << 14` only.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "mentions_only".

## integrations-discord-025

- Vitest: "verified Discord integration settings > reports mentions-only when the authoritative flags do not grant content"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord reports the configured application with `flags` `1 << 18` but `flags_new` "0".
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "mentions_only".

## integrations-discord-026

- Vitest: "verified Discord integration settings > does not claim content access from invalid or mismatched application metadata"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord's application discovery returns a different application ID (`123456789012345679`) with `flags` `1 << 18`.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "unavailable".

## integrations-discord-027

- Vitest: "verified Discord integration settings > does not claim content access from invalid or mismatched application metadata"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord's application discovery returns the configured application ID without any `flags` field.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "unavailable".

## integrations-discord-028

- Vitest: "verified Discord integration settings > reports unavailable context when application discovery fails with 401"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord's application discovery fails with HTTP 401.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "unavailable".

## integrations-discord-029

- Vitest: "verified Discord integration settings > reports unavailable context when application discovery fails with 429"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord's application discovery fails with HTTP 429.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "unavailable".

## integrations-discord-030

- Vitest: "verified Discord integration settings > reports unavailable context when application discovery fails with 500"
- Mode: run
- Given: A signed-in workspace admin has installed the Discord bot, and Discord's application discovery fails with HTTP 500.
- When: The admin requests `GET /api/integrations/discord`.
- Then: The status has `contextMode` "unavailable".

## integrations-discord-031

- Vitest: "verified Discord integration settings > disconnects only the caller while preserving the guild and another verified user"
- Mode: run
- Given: A workspace admin has installed the Discord bot in a guild, and a peer in the same workspace has connected their own Discord account to that guild.
- When: The admin calls `DELETE /api/integrations/discord`, reads both users' statuses, and calls `DELETE /api/integrations/discord` again.
- Then: The first disconnect returns HTTP 200 and publishes one `discord:changed` event (null payload) to the admin's user channel only. The admin's status shows `isConnected: false`, `discordUserId` null, no DM bindings and a null DM selection. The peer remains connected with their Discord user ID. The second disconnect returns HTTP 404 and publishes nothing further.

## integrations-discord-032

- Vitest: "verified Discord integration settings > notifies only the disconnecting user and preserves peers and cached admins"
- Mode: run
- Given: A workspace admin has installed the Discord bot; a connected peer, an unconnected admin and an unconnected member share the workspace, and another workspace has its own installation. The owner, unconnected admin, unconnected member and other owner have each signed in with a CLI token so their memberships are cached.
- When: The unconnected admin reads `GET /api/integrations/discord`; the owner calls `DELETE /api/integrations/discord` twice; the peer and the other owner read their statuses.
- Then: The unconnected admin sees `isConnected: false` and no event is published. The first disconnect returns HTTP 200 and publishes `discord:changed` only to the owner's user channel. The peer stays connected and the other owner stays connected to their own guild. The second disconnect returns HTTP 404 with no additional publication.

## integrations-discord-033

- Vitest: "verified Discord integration settings > hides revoked membership and refuses subsequent binding mutations"
- Mode: run
- Given: A workspace admin has installed the Discord bot, but the admin's organization membership is no longer reported by the identity provider.
- When: The admin reads `GET /api/integrations/discord`, then calls `PUT /api/integrations/discord/dm-selection` with their connection ID and `DELETE /api/integrations/discord`.
- Then: The status shows `isConnected: false` with no DM bindings. The DM selection and the disconnect both return HTTP 404, and no `discord:changed` event is published.

## integrations-discord-034

- Vitest: "verified Discord integration settings > keeps DM bindings and saved choices isolated across successive user requests"
- Mode: run
- Given: Two unrelated workspace admins have each installed the Discord bot with their own Discord accounts.
- When: Each admin calls `PUT /api/integrations/discord/dm-selection` with their own connection ID, then the statuses are read alternately (first, second, first) via `GET /api/integrations/discord`.
- Then: Both selections return HTTP 200. Every status shows only the caller's own Discord user ID, exactly one DM binding for their own connection (guild ID, guild name, workspace name "Discord test workspace"), and `dmSelectionConnectionId` equal to their own connection.

## integrations-discord-035

- Vitest: "verified Discord integration settings > requires an explicit DM choice across organizations and invalidates a revoked choice"
- Mode: run
- Given: The same Okou user and Discord account are bound through guild installs in three organizations.
- When: The user reads `GET /api/integrations/discord`, selects the second connection via `PUT /api/integrations/discord/dm-selection`, then selects the third and the second again, the second organization disconnects with `DELETE /api/integrations/discord`, and the user reads status and tries to select the second connection again.
- Then: The first status has a null DM selection and all three connections. Each selection returns HTTP 200, is reflected in the status, and publishes one `discord:changed` event to the user. The disconnect returns HTTP 200 and publishes one more event to the user. Afterwards the DM selection is null, only the first and third connections remain, and re-selecting the second returns HTTP 404 without publishing.

## integrations-discord-036

- Vitest: "verified Discord integration settings > keeps the previous DM choice when a requested binding is disconnected while reading the body"
- Mode: run
- Given: The same Okou user and Discord account are bound through guild installs in two organizations, and the user has selected the first connection for DMs.
- When: The user starts `PUT /api/integrations/discord/dm-selection` for the second connection with a streamed body; while the body is still being read, the second organization disconnects via `DELETE /api/integrations/discord`, then the body completes.
- Then: The disconnect returns HTTP 200 and publishes one `discord:changed` event to the user. The selection returns HTTP 404 and publishes nothing. The status still selects the first connection and lists only the first connection's DM binding.

## integrations-discord-037

- Vitest: "verified Discord integration settings > keeps the previous DM choice when the requested connection is revoked during revalidation"
- Mode: run
- Given: The same Okou user and Discord account are bound through guild installs in two organizations, and the user has selected the first connection for DMs. The second organization disconnects at the moment its membership is revalidated.
- When: The user calls `PUT /api/integrations/discord/dm-selection` for the second connection.
- Then: The selection returns HTTP 404, the revocation occurred during the request, and exactly one `discord:changed` event (from the disconnect) is published to the user. The status still selects the first connection and lists only the first connection's DM binding.

## integrations-discord-038

- Vitest: "verified Discord integration settings > rejects DM selections for another Discord sender or another Okou user"
- Mode: run
- Given: A workspace admin has installed the Discord bot. The same Okou user has another installation linked to a different Discord account, and a different Okou user has their own installation.
- When: The admin calls `PUT /api/integrations/discord/dm-selection` with each foreign connection ID, reads status, and then selects their own connection.
- Then: Both foreign selections return HTTP 404 with no published event, and the status lists only the admin's own DM binding. Selecting the admin's own connection returns HTTP 200 and publishes one `discord:changed` event to the admin.
