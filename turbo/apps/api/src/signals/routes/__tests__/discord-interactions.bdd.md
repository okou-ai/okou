# discord-interactions

## discord-interactions-001

- Vitest: "Discord private account interactions > acknowledges once, replies privately, and rejects a replay before side effects"
- Mode: run
- Given: The Discord app is configured and Discord supplies a signed `/help` interaction.
- When: Discord posts to `/api/discord/interactions`, waits for the reply, and resends the same interaction.
- Then: Both requests return HTTP 202. The initial Discord acknowledgement is deferred and ephemeral (type 5, flags 64). There is one delivered help reply mentioning `/disconnect`, Commands and Usage, with no mention parsing.

## discord-interactions-002

- Vitest: "Discord private account interactions > gives an unbound sender setup guidance for /connect"
- Mode: run
- Given: A Discord sender has no linked Okou account.
- When: Discord sends a signed `/connect` interaction to `POST /api/discord/interactions`.
- Then: The API returns HTTP 202. The private reply says `Please connect your account to use Okou from Discord.` and contains one `Connect` link button to the Discord settings page.

## discord-interactions-003

- Vitest: "Discord private account interactions > gives an unbound sender setup guidance for /disconnect"
- Mode: run
- Given: A Discord sender has no linked Okou account.
- When: Discord sends a signed `/disconnect` interaction to `POST /api/discord/interactions`.
- Then: The API returns HTTP 202. The private reply says `Please connect your account to use Okou from Discord.` and contains one `Connect` link button to the Discord settings page.

## discord-interactions-004

- Vitest: "Discord private account interactions > links a server /connect command directly to setup for that server"
- Mode: run
- Given: A Discord member invokes the bot from a server with a known guild ID.
- When: Discord posts the server's signed `/connect` interaction.
- Then: HTTP 202 is followed by a deferred ephemeral acknowledgement and a private `Connect` button to the Discord settings page with that guild ID.

## discord-interactions-005

- Vitest: "Discord private account interactions > rejects a forged picker without reading or changing another account"
- Mode: run
- Given: Discord supplies a signed component selection whose picker state is invalid for the sender.
- When: Discord posts it to the interaction endpoint.
- Then: The API returns HTTP 202, sends a deferred component update (type 6), and clears the controls on the picker with a message saying it expired or access changed.

## discord-interactions-006

- Vitest: "Discord private account interactions > does not execute work after a rejected callback acknowledgement"
- Mode: run
- Given: Discord rejects the callback acknowledgement as HTTP 404 `Unknown interaction`.
- When: Discord sends a signed `/disconnect` interaction to Okou.
- Then: The API returns HTTP 503 with `Discord could not acknowledge the interaction`. No edit request is sent to the original Discord message.

## discord-interactions-007

- Vitest: "Discord private account interactions > reports no change instead of failing after a network failure acknowledgement"
- Mode: run
- Given: Discord's callback acknowledgement is interrupted by a network failure and Discord's three-second response window elapses.
- When: Discord sends signed `/help` to Okou.
- Then: The API returns HTTP 202. Exactly one Discord message edit says `no changes were made`, includes no `/disconnect` help content, and clears the controls.

## discord-interactions-008

- Vitest: "Discord private account interactions > reports no change instead of failing after a Discord server error acknowledgement"
- Mode: run
- Given: Discord's callback acknowledgement is interrupted by an HTTP 503 from Discord and Discord's three-second response window elapses.
- When: Discord sends signed `/help` to Okou.
- Then: The API returns HTTP 202. Exactly one Discord message edit says `no changes were made`, includes no `/disconnect` help content, and clears the controls.

## discord-interactions-009

- Vitest: "Discord private account interactions > accepts Discord rejecting the no-change edit when the acknowledgement never arrived"
- Mode: run
- Given: A signed `/disconnect` interaction's callback acknowledgement suffers a network failure until the response window expires, and Discord returns HTTP 404 `Unknown Webhook` on an original-message edit.
- When: Discord posts that interaction to Okou.
- Then: Okou still returns HTTP 202 and attempts the no-change edit.
