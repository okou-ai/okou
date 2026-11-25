# chat-threads-create

## chat-threads-create-001

- Vitest: "POST /api/chat-threads > snapshots the member's cloud browser preference (true) and preserves it on replay"
- Mode: run
- Given: A member with personal subscriptions and saved model `claude-sonnet-5-5` sets the preference `cloudBrowserEnabledByDefault` to `true` (row `true`) and holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads` and a `clientThreadId`; the member flips the preference to `false`; the token replays the same create and then creates a chat with a new `clientThreadId`.
- Then: The first chat's `created` event in `GET /api/chat-threads/events` has `cloudBrowserEnabled: true`. The replay returns the same ID, `GET /api/chat-threads/:id/metadata` still shows `cloudBrowserEnabled: true`, and only one `created` event exists. The new chat shows `cloudBrowserEnabled: false` in its metadata and `created` event.

## chat-threads-create-002

- Vitest: "POST /api/chat-threads > snapshots the member's cloud browser preference (false) and preserves it on replay"
- Mode: run
- Given: A member with personal subscriptions and saved model `claude-sonnet-5-5` sets the preference `cloudBrowserEnabledByDefault` to `false` (row `false`) and holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads` and a `clientThreadId`; the member flips the preference to `true`; the token replays the same create and then creates a chat with a new `clientThreadId`.
- Then: The first chat's `created` event in `GET /api/chat-threads/events` has `cloudBrowserEnabled: false`. The replay returns the same ID, `GET /api/chat-threads/:id/metadata` still shows `cloudBrowserEnabled: false`, and only one `created` event exists. The new chat shows `cloudBrowserEnabled: true` in its metadata and `created` event.

## chat-threads-create-003

- Vitest: "POST /api/chat-threads > creates initial SSH and VNC overrides and preserves them on replay"
- Mode: run
- Given: A signed-in member has an SSH host "Selected host" whose default is enabled and a VNC connection.
- When: The member creates a chat with `POST /api/chat-threads` and `initialRemoteAccessOverrides` disabling the SSH host and enabling the VNC connection, replays it with inverted overrides, deletes the SSH host (HTTP 204) and replays again, then creates another chat whose override references an unknown SSH host.
- Then: `GET /api/chat-threads/:threadId/remote-access` shows SSH `enabled: false`, `overrideEnabled: false` and VNC `enabled: true`, `overrideEnabled: true`, both with `source: "override"`; the inverted replay leaves the overrides unchanged. The replay after host deletion returns HTTP 201 with the same thread ID. The unknown-host create returns HTTP 400 and that chat's remote access returns HTTP 404.

## chat-threads-create-004

- Vitest: "POST /api/chat-threads > does not let a run token choose access to a host when creating a chat"
- Mode: run
- Given: A member owns an SSH host "Disabled host" with its default disabled and holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads` and an initial remote-access override enabling that host.
- Then: The request returns HTTP 403 `FORBIDDEN`, and the member's `GET /api/chat-threads/:threadId/remote-access` for that thread ID returns HTTP 404.

## chat-threads-create-005

- Vitest: "POST /api/chat-threads > repairs selected and inherited accounts during deletion"
- Mode: run
- Given: A member has two OpenAI API-token connector accounts, "First" and "Second", and an Okou run token creates two chats, one with no selection and one selecting "Second" via `PUT /api/chat-threads/:id/connector-selections`.
- When: The member reads `GET /api/connector-accounts/:connectionId/deletion-impact` for "Second", deletes "Second", reads both chats' selections, deletes "First", reads the selected chat again, and the token replays the selected chat's create with its ID as `clientThreadId`.
- Then: The impact reports 1 explicit selection, and deleting "Second" resolves 1 selection, moving the selected chat to "First" in both selections and selected connections, while the other chat stays empty. Deleting "First" resolves 1 selection and leaves the selected chat with no selections. The replay returns the original create body, and only one `created` event exists for that chat.

## chat-threads-create-006

- Vitest: "POST /api/chat-threads > refreshes builtin and custom selection authorization after Chat allowance changes"
- Mode: run
- Given: A signed-in member has an OpenAI API-token account and a custom HTTP connector account, and creates a chat with `model: null` selecting both accounts via `PUT /api/chat-threads/:id/connector-selections`.
- When: The member disallows each account in the chat with `PUT /api/chat-threads/:threadId/connector-access/:connectionId` and tries to select it again, then allows each account again and selects it.
- Then: Both selections are initially stored. While disallowed, each selection returns HTTP 400 `BAD_REQUEST` "Account is unavailable or not allowed in this Chat" and the chat has no selections. After allowing again, each update returns the selection body, and the final selections equal the initial ones.

## chat-threads-create-007

- Vitest: "POST /api/chat-threads > sets and reads an exact built-in connector account"
- Mode: run
- Given: A member has an OpenAI API-token account and an Okou run token that created a chat; another organization member has their own OpenAI account, and the member also belongs to a second organization.
- When: The token selects the member's account via `PUT /api/chat-threads/:id/connector-selections`, tries to select the other member's account, the other member's and the second organization's run tokens read the selections, the token reselects the account, tries to select it for the `github` target, and then reselects it while the member concurrently deletes the account.
- Then: The selection reads back as that account with one `connected` selected connection. Selecting the foreign account returns HTTP 400, and both foreign tokens get HTTP 404 on read. Reselecting returns the connection ID and publishes `chatThreadDetailChanged:<threadId>`. The `github` target returns HTTP 400. During the concurrent race the selection returns HTTP 200 or 400, the deletion returns HTTP 200, and the chat ends with no selections.

## chat-threads-create-008

- Vitest: "POST /api/chat-threads > sets exact custom HTTP and MCP connector accounts"
- Mode: run
- Given: A member has a custom HTTP connector account and a custom MCP connector account, and an Okou run token created a chat.
- When: The token selects both accounts via `PUT /api/chat-threads/:id/connector-selections`, and the member deletes the HTTP account with `DELETE /api/connector-accounts/:connectionId`.
- Then: The chat first has two selections and two selected connections covering both accounts; after the deletion only the MCP account selection remains.

## chat-threads-create-009

- Vitest: "POST /api/chat-threads > keeps custom selection deleted to surviving consistent with default deletion"
- Mode: run
- Given: A member has a custom HTTP connector with two accounts, "Surviving" and "Deleted", where "Deleted" is the default (`POST /api/connector-accounts/:connectionId/default`), and a chat created with an Okou run token whose connector selection initially points to the deleted account (row initial `deleted`, selected `surviving`).
- When: The run token changes the thread selection to the surviving account with `PUT /api/chat-threads/:id/connector-selections` while the member concurrently deletes the "Deleted" account with `DELETE /api/connector-accounts/:connectionId`, then the selections and `GET /api/connector-accounts/connections` are read.
- Then: The selection update and the deletion both return HTTP 200. The deletion promotes "Surviving" as default and resolves 0 or 1 selections, the chat selects "Surviving", and `GET /api/connector-accounts/connections` lists only "Surviving" as the default account.

## chat-threads-create-010

- Vitest: "POST /api/chat-threads > keeps custom selection surviving to deleted consistent with default deletion"
- Mode: run
- Given: A member has a custom HTTP connector with two accounts, "Surviving" and "Deleted", where "Deleted" is the default (`POST /api/connector-accounts/:connectionId/default`), and a chat created with an Okou run token whose connector selection initially points to the surviving account (row initial `surviving`, selected `deleted`).
- When: The run token changes the thread selection to the deleted account with `PUT /api/chat-threads/:id/connector-selections` while the member concurrently deletes the "Deleted" account with `DELETE /api/connector-accounts/:connectionId`, then the selections and `GET /api/connector-accounts/connections` are read.
- Then: The selection returns HTTP 200 or 400 and the deletion returns HTTP 200 or 400. If the deletion is rejected with HTTP 400 `BAD_REQUEST` "Connector account selection changed during deletion; refresh and try again", the selection succeeded, the chat selects "Deleted", and both accounts remain with "Deleted" as default. Otherwise the deletion promotes "Surviving" as default, resolves 1 selection when the selection succeeded (else 0), the chat keeps "Surviving" only if the selection was rejected (else no selection), and only "Surviving" remains as the default account.

## chat-threads-create-011

- Vitest: "POST /api/chat-threads > keeps custom selection deleted to deleted consistent with default deletion"
- Mode: run
- Given: A member has a custom HTTP connector with two accounts, "Surviving" and "Deleted", where "Deleted" is the default (`POST /api/connector-accounts/:connectionId/default`), and a chat created with an Okou run token whose connector selection initially points to the deleted account (row initial `deleted`, selected `deleted`).
- When: The run token changes the thread selection to the deleted account with `PUT /api/chat-threads/:id/connector-selections` while the member concurrently deletes the "Deleted" account with `DELETE /api/connector-accounts/:connectionId`, then the selections and `GET /api/connector-accounts/connections` are read.
- Then: The selection returns HTTP 200 or 400 and the deletion returns HTTP 200. The deletion promotes "Surviving" as default and resolves 1 selection, the chat ends with no selections, and only "Surviving" remains as the default account.

## chat-threads-create-012

- Vitest: "POST /api/chat-threads > routes thread-list invalidations only to the user-org channel"
- Mode: run
- Given: A member with personal subscriptions holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads` and model `claude-sonnet-5-5`.
- Then: Realtime uses only the `user-org:<userId>:<orgId>` channel and publishes exactly one `threadListChanged` message with `null` data.

## chat-threads-create-013

- Vitest: "POST /api/chat-threads > creates a titled thread with an Okou run token carrying chat-thread:write"
- Mode: run
- Given: A member with personal subscriptions and saved model `claude-sonnet-5-5` holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads`, title "Deep dive on P2" and model `claude-opus-5-5`, and reads its metadata.
- Then: The response is HTTP 201 with exactly the ID, title, creation time, selected model `claude-opus-5-5` and `serviceTier: null`. The metadata shows the title, no pin, not archived, hidden or muted, model `claude-opus-5-5`, empty model settings, no service tier, no computer-use host, and `cloudBrowserEnabled: true`.

## chat-threads-create-014

- Vitest: "POST /api/chat-threads > uses the member default for a new thread instead of the caller run model"
- Mode: run
- Given: A Pro member with saved model `claude-sonnet-5-5` has a chat on model `claude-opus-5-5` with a running Run whose execution uses `claude-opus-5-5` and carries an `OKOU_TOKEN`.
- When: The Run's token creates a chat with `POST /api/chat-threads` and only a title, and reads its metadata.
- Then: The new chat's selected model is `claude-sonnet-5-5` in both the response and the metadata, and its service tier is `null`.

## chat-threads-create-015

- Vitest: "POST /api/chat-threads > uses the member model and priority default and allows an explicit standard override"
- Mode: run
- Given: A Pro member with native subscriptions sets `PUT /api/user-model-preference` to model `gpt-6-sol` with service tier `priority`; a run token creates a source chat with that model and tier, which has a running Run.
- When: The running Run's `OKOU_TOKEN` creates a chat with only a title, and then a chat with explicit `serviceTier: null`.
- Then: The source chat reports `priority`, and its Run's execution uses `gpt-6-sol` with service tier `fast`. The inherited chat uses `gpt-6-sol` with `priority` in both the response and metadata, and the explicit standard chat uses `gpt-6-sol` with `serviceTier: null`.

## chat-threads-create-016

- Vitest: "POST /api/chat-threads > uses the workspace default when the request omits a model"
- Mode: run
- Given: A member with personal subscriptions and saved model `claude-sonnet-5-5` holds an Okou run token.
- When: The run token creates a chat with `POST /api/chat-threads` and only the title "No model anywhere".
- Then: The response has selected model `claude-sonnet-5-5` and `serviceTier: null`.

## chat-threads-create-017

- Vitest: "POST /api/chat-threads > replays one thread when a create request is delivered twice"
- Mode: run
- Given: A member with personal subscriptions and default feature switches holds an Okou run token.
- When: The run token sends the same `POST /api/chat-threads` request twice with a `clientThreadId`, an event ID, title "Duplicate delivery" and model `claude-opus-5-5`.
- Then: The first response uses the client thread ID, the second response body equals the first, and exactly one `created` event exists for the chat.

## chat-threads-create-018

- Vitest: "POST /api/chat-threads > replays the stored thread instead of the repeated request body"
- Mode: run
- Given: A member holds an Okou run token that created a chat with a `clientThreadId`, title "Title from the request" and model `claude-opus-5-5`, and then renamed it to "Title the member chose" (HTTP 204).
- When: The run token repeats the original create request.
- Then: The response is the stored chat: same ID and creation time, title "Title the member chose", model `claude-opus-5-5` and `serviceTier: null`, and the metadata title is "Title the member chose".

## chat-threads-create-019

- Vitest: "POST /api/chat-threads > creates one thread when two deliveries race on a client thread id"
- Mode: run
- Given: A member holds an Okou run token.
- When: The run token sends two identical `POST /api/chat-threads` requests concurrently with the same `clientThreadId`, event ID, title "Raced delivery" and model `claude-opus-5-5`.
- Then: Both return HTTP 201 with equal bodies using the client thread ID, and exactly one `created` event exists for the chat.

## chat-threads-create-020

- Vitest: "POST /api/chat-threads > answers a client thread id owned by another member like a missing thread"
- Mode: run
- Given: A member's Okou run token created "Owner thread" with a given `clientThreadId`; a member of another workspace holds their own run token.
- When: The other member sends `POST /api/chat-threads` with the same `clientThreadId` and title "Colliding thread".
- Then: The response is HTTP 404 `{ error: { code: "NOT_FOUND", message: "Chat thread not found" } }`, and the owner's chat metadata still has the title "Owner thread".

## chat-threads-create-021

- Vitest: "POST /api/chat-threads > returns the existing member thread when a create is retried"
- Mode: run
- Given: A member's Okou run token created a chat with a given `clientThreadId` and title "First title".
- When: The run token sends `POST /api/chat-threads` again with the same `clientThreadId` and title "Updated title".
- Then: The response is HTTP 201 with the same thread ID, and the metadata title remains "First title".
