# discord-gateway-identity

## discord-gateway-identity-001

- Vitest: "Discord Gateway message identity > rejects a signed replay with changed author identity and preserves the original input"
- Mode: run
- Given: A valid connected Discord member mentions the bot in a guild conversation. Two concurrent, signed deliveries of the same Discord message, with different delivery event IDs, report one accepted and one duplicate and create one prompt.
- When: The authenticated Gateway submits another signed `MESSAGE_CREATE` at `POST /api/internal/discord/gateway` for the same message ID with a different author ID, then replays the original identity.
- Then: The changed identity returns HTTP 400, code `BAD_REQUEST`, and `Message identity changed`. The original replay is still a duplicate. Reading chat threads returns the original thread and its projected events contain the same single prompt as before.

## discord-gateway-identity-002

- Vitest: "Discord Gateway message identity > rejects a signed replay with changed channel identity and preserves the original input"
- Mode: run
- Given: A valid connected Discord member mentions the bot in a guild conversation. Two concurrent, signed deliveries of the same Discord message, with different delivery event IDs, report one accepted and one duplicate and create one prompt.
- When: The authenticated Gateway submits another signed `MESSAGE_CREATE` at `POST /api/internal/discord/gateway` for the same message ID with a different channel ID, then replays the original identity.
- Then: The changed identity returns HTTP 400, code `BAD_REQUEST`, and `Message identity changed`. The original replay is still a duplicate. Reading chat threads returns the original thread and its projected events contain the same single prompt as before.

## discord-gateway-identity-003

- Vitest: "Discord Gateway message identity > rejects a signed replay with changed guild identity and preserves the original input"
- Mode: run
- Given: A valid connected Discord member mentions the bot in a guild conversation. Two concurrent, signed deliveries of the same Discord message, with different delivery event IDs, report one accepted and one duplicate and create one prompt.
- When: The authenticated Gateway submits another signed `MESSAGE_CREATE` at `POST /api/internal/discord/gateway` for the same message ID with a different guild ID, then replays the original identity.
- Then: The changed identity returns HTTP 400, code `BAD_REQUEST`, and `Message identity changed`. The original replay is still a duplicate. Reading chat threads returns the original thread and its projected events contain the same single prompt as before.
