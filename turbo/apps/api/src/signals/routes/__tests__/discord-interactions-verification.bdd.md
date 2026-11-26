# discord-interactions-verification

## discord-interactions-verification-001

- Vitest: "POST /api/discord/interactions signature and protocol validation > answers PING signed over the exact whitespace and UTF-8 request bytes"
- Mode: run
- Given: The configured Discord application has a valid Ed25519 key and sends a PING body with indentation and non-ASCII text. The signature covers those exact bytes.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 200 with a PING response whose only field is `type: 1`, even though bot command credentials are not configured.

## discord-interactions-verification-002

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects reserialized JSON whose meaning matches the signed body"
- Mode: run
- Given: Discord signs the compact JSON bytes of a PING and delivers reserialized, indented bytes with the same JSON meaning.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-003

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects invalid Ed25519 signature xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
- Mode: run
- Given: A PING has a current timestamp and an invalid Ed25519 signature: a 128-character nonhex string.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-004

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects invalid Ed25519 signature 000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
- Mode: run
- Given: A PING has a current timestamp and an invalid Ed25519 signature: 126 hexadecimal characters.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-005

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects invalid Ed25519 signature 0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
- Mode: run
- Given: A PING has a current timestamp and an invalid Ed25519 signature: 130 hexadecimal characters.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-006

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects invalid Ed25519 signature 00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
- Mode: run
- Given: A PING has a current timestamp and an invalid Ed25519 signature: 128 hexadecimal characters of zeros that do not verify.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-007

- Vitest: "POST /api/discord/interactions signature and protocol validation > requires the x-signature-ed25519 header"
- Mode: run
- Given: A PING otherwise has valid authentication but omits `x-signature-ed25519`.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-008

- Vitest: "POST /api/discord/interactions signature and protocol validation > requires the x-signature-timestamp header"
- Mode: run
- Given: A PING otherwise has valid authentication but omits `x-signature-timestamp`.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-009

- Vitest: "POST /api/discord/interactions signature and protocol validation > accepts a signature at the -300-second time boundary"
- Mode: run
- Given: The PING signature and body match the configured application, with a timestamp five minutes in the past relative to server time.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 200.

## discord-interactions-verification-010

- Vitest: "POST /api/discord/interactions signature and protocol validation > accepts a signature at the 30-second time boundary"
- Mode: run
- Given: The PING signature and body match the configured application, with a timestamp thirty seconds in the future relative to server time.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 200.

## discord-interactions-verification-011

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signature outside the -301-second time boundary"
- Mode: run
- Given: The PING signature matches the body, but its timestamp is 301 seconds in the past.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-012

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signature outside the 31-second time boundary"
- Mode: run
- Given: The PING signature matches the body, but its timestamp is 31 seconds in the future.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-013

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a non-decimal timestamp 1790244000extra even when correctly signed"
- Mode: run
- Given: The PING is correctly signed over the supplied timestamp text, but that text has a trailing suffix.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-014

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a non-decimal timestamp 1790244000.0 even when correctly signed"
- Mode: run
- Given: The PING is correctly signed over the supplied timestamp text, but that text has a fractional suffix.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-015

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a non-decimal timestamp +1790244000 even when correctly signed"
- Mode: run
- Given: The PING is correctly signed over the supplied timestamp text, but that text has a leading plus sign.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-016

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a non-decimal timestamp 1e9 even when correctly signed"
- Mode: run
- Given: The PING is correctly signed over the supplied timestamp text, but that text uses scientific notation.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-017

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed interaction for a different application"
- Mode: run
- Given: A correctly signed PING names a different Discord application.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 401.

## discord-interactions-verification-018

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: missing actor"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but a DM command has no actor.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-019

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: guild with DM identity"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but a guild command supplies only a DM-form user identity.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-020

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: guild with two identities"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but a guild command supplies both a DM-form user and a guild member.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-021

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: DM with member identity"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but a DM command supplies a guild member instead of a user.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-022

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: unsupported modal"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but the payload is an unsupported modal submission.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-023

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: unsupported component"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but the submitted component is an unsupported type.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-024

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: multiple selected values"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but a select interaction contains two selected values.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-025

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects a signed malformed interaction: unknown command"
- Mode: run
- Given: The interaction is correctly signed for the configured application, but the received command name is unknown.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400.

## discord-interactions-verification-026

- Vitest: "POST /api/discord/interactions signature and protocol validation > rejects an oversized signed payload before parsing"
- Mode: run
- Given: Discord supplies a signed request of 65,537 whitespace bytes.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 400 before parsing.

## discord-interactions-verification-027

- Vitest: "POST /api/discord/interactions signature and protocol validation > reports unavailable configuration without DISCORD_APPLICATION_ID"
- Mode: run
- Given: The configured deployment is missing its Discord application ID and receives a signed PING.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 503.

## discord-interactions-verification-028

- Vitest: "POST /api/discord/interactions signature and protocol validation > reports unavailable configuration without DISCORD_PUBLIC_KEY"
- Mode: run
- Given: The configured deployment is missing its Discord public key and receives a signed PING.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 503.

## discord-interactions-verification-029

- Vitest: "POST /api/discord/interactions signature and protocol validation > requires bot configuration before accepting an account command"
- Mode: run
- Given: The Discord application ID and public key are set, but no bot token is configured. A correctly signed account command arrives.
- When: Discord sends the request to `POST /api/discord/interactions`.
- Then: The API returns HTTP 503.
