# register-discord-commands

## register-discord-commands-001

- Vitest: "standalone help works without any server or Discord configuration"
- Mode: run
- Intent: review
- Given: The registration CLI is available with an empty environment.
- When: An operator invokes `--help`.
- Then: The CLI exits 0 and explains that dry-run JSON is the default and guild commands are unavailable in bot DMs.

## register-discord-commands-002

- Vitest: "standalone guild preview needs no server configuration or token"
- Mode: run
- Intent: review
- Given: The operator has a valid application ID and guild ID. The CLI has no server settings or bot token.
- When: The operator runs the CLI for the guild and application without `--apply`.
- Then: The CLI exits 0 with dry-run JSON targeting a POST to the specified guild's Discord command collection. It proposes `help`, `connect` and `disconnect` with no contexts or integration types, and removal of the chat-input commands `okou`, `switch` and `model`.

## register-discord-commands-003

- Vitest: "standalone invocation exits unsuccessfully when the scope is absent"
- Mode: run
- Intent: review
- Given: The CLI is launched with an empty environment.
- When: An operator invokes `--apply` without a scope.
- Then: The CLI exits 1, writes nothing to stdout and asks the operator to specify `--guild <test-guild-id>` on stderr.

## register-discord-commands-004

- Vitest: "scope and snowflake validation prevent unintended destinations"
- Mode: run
- Intent: review
- Given: A Discord application and token are configured.
- When: The operator invokes registration with no scope, `--apply` alone, both guild and global scopes, a path-like guild value, a guild value beyond unsigned 64-bit range, or an invalid application ID.
- Then: Every invocation rejects.

## register-discord-commands-005

- Vitest: "apply requires a token and rejects malformed tokens without echoing them"
- Mode: run
- Intent: review
- Given: The application and guild IDs are valid. In separate trials the token is absent, empty, or contains a newline.
- When: An operator applies guild registration.
- Then: Each application rejects with `Set DISCORD_BOT_TOKEN to a valid token without whitespace before using --apply.` The error contains no token value.

## register-discord-commands-006

- Vitest: "guild registration removes retired commands and preserves unrelated commands"
- Mode: run
- Intent: review
- Given: The guild has retired chat-input commands `okou`, `switch` and `model`, an unrelated `status` command and non-chat-input commands also named `okou` and `model`.
- When: An authenticated operator applies guild registration, lists the guild commands through Discord and applies again.
- Then: Discord receives Bot-authenticated requests. The new chat-input commands are `help`, `connect` and `disconnect`, and only the three retired chat-input commands are removed. The unrelated entries are unchanged. Output reports the three removals and prompts verification of `/help` without exposing the token. Reapplying leaves the Discord list unchanged.

## register-discord-commands-007

- Vitest: "global preview explicitly supports guild and bot DM contexts"
- Mode: run
- Intent: review
- Given: The operator has an application ID and no bot token.
- When: The operator previews global registration.
- Then: The preview targets the application's global Discord command collection. Every command has guild and bot DM contexts `[0, 1]` and guild-install integration type `[0]`.

## register-discord-commands-008

- Vitest: "global registration leaves commands in other scopes unchanged"
- Mode: run
- Intent: review
- Given: The global scope has retired command registrations, and a guild has its own `okou` command.
- When: An authenticated operator applies global registration and reads both scopes through Discord.
- Then: Global commands become `help`, `connect` and `disconnect`. The guild's command is unchanged and the CLI describes the global scope as guilds and bot DMs.

## register-discord-commands-009

- Vitest: "a partial registration preserves the grouped command until every replacement succeeds"
- Mode: run
- Intent: review
- Given: The guild has an existing `okou` command. Discord accepts `help` and `connect`, then returns HTTP 429 with `Retry-After: 2.5` for `disconnect`.
- When: An authenticated operator applies registration and reads the guild commands after it rejects.
- Then: The error reports Discord rate limiting and a 2.5-second retry delay. The previous `okou` entry remains exactly as before, and the command list contains `okou`, `help` and `connect`. Output reports the two successful registrations without exposing the token.

## register-discord-commands-010

- Vitest: "Discord authorization errors expose no provider body or token"
- Mode: run
- Intent: review
- Given: Discord denies the guild command listing with HTTP 401 and includes token text in its response body.
- When: An operator applies guild registration.
- Then: The CLI reports HTTP 401 and asks the operator to check the application ID, bot token and bot installation in the guild. The provider body and token value are omitted.

## register-discord-commands-011

- Vitest: "a mismatched registration receipt cannot be reported as success"
- Mode: run
- Intent: review
- Given: The guild has its previous `okou` command and Discord acknowledges the new `help` command with a different guild ID.
- When: An authenticated operator applies guild registration.
- Then: The operation rejects with an unexpected command registration error, writes no success output and leaves only the previous command in the guild listing.

## register-discord-commands-012

- Vitest: "a command list with an unexpected scope cannot authorize cleanup"
- Mode: run
- Intent: review
- Given: The requested Discord guild command list returns an `okou` registration with no guild ID.
- When: An authenticated operator applies guild registration.
- Then: The operation rejects with an unexpected command registration error and emits no success output.
