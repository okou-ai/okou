# model-identity-writes

## model-identity-writes-001

- Vitest: "model identity new writes > creates canonical Auto from intent null"
- Mode: run
- Given: A signed-in workspace member (row `null`).
- When: The member creates a thread via `POST /api/chat-threads` with `model: null`, reads its metadata, and lists `GET /api/chat-threads/events`.
- Then: The thread metadata shows selected model `auto`, empty model settings and service tier `null`, and the thread events include a `created` event for the thread with selected model `auto`.

## model-identity-writes-002

- Vitest: "model identity new writes > creates canonical Auto from intent auto"
- Mode: run
- Given: A signed-in workspace member (row `auto`).
- When: The member creates a thread via `POST /api/chat-threads` with `model: "auto"`, reads its metadata, and lists `GET /api/chat-threads/events`.
- Then: The thread metadata shows selected model `auto`, empty model settings and service tier `null`, and the thread events include a `created` event for the thread with selected model `auto`.

## model-identity-writes-003

- Vitest: "model identity new writes > resolves an omitted creation model from the member's personal preference"
- Mode: run
- Given: A signed-in member has a connected personal subscription with `claude-sonnet-5-5` as their preferred model.
- When: The member creates a thread via `POST /api/chat-threads` with an empty body.
- Then: The response is HTTP 201 with selected model `claude-sonnet-5-5`, and the thread metadata reads back `claude-sonnet-5-5`.

## model-identity-writes-004

- Vitest: "model identity new writes > preserves a personal selection and effort when rename and send omit the model"
- Mode: run
- Given: A Pro-entitled member with a connected `claude-sonnet-5-5` subscription has a thread on that model with reasoning effort `extra`; a Runner group is configured.
- When: The member renames the thread via `POST /api/chat-threads/:id/rename`, sends a Run on the thread without a model, reads `GET /api/logs/:id`, switches the thread to `auto`, cancels the Run, and reads the log again.
- Then: The thread metadata shows the new title, model `claude-sonnet-5-5` and effort `extra` for that model. The thread history has an `input.prompt` event for the Run whose user message includes a `model` part for `claude-sonnet-5-5`. The log shows selected model `claude-sonnet-5-5`, runtime provider `claude-code-oauth-token` and a non-empty runtime model, and the later log read keeps the same three values.

## model-identity-writes-005

- Vitest: "model identity new writes > keeps personal effort when switching to Auto and rejects Auto effort and Fast"
- Mode: run
- Given: A member with a connected `claude-sonnet-5-5` subscription has a thread on that model with reasoning effort `extra`.
- When: The member switches the thread to Auto via `POST /api/chat-threads/:id/model-selection` with model `null`, then tries to select `auto` with reasoning effort `high` and with `codexServiceTier: fast`.
- Then: After the switch the metadata shows `auto`, keeps `claude-sonnet-5-5` effort `extra`, and service tier `null`. Both Auto requests with effort or Fast return HTTP 400, and the metadata is unchanged.

## model-identity-writes-006

- Vitest: "model identity new writes > writes canonical Auto on a send and launches the managed route"
- Mode: run
- Given: A Pro-entitled member without a personal subscription; a Runner group is configured and the platform has a managed model key.
- When: The member sends a new thread Run with prompt "Use the platform model" and `model: null`.
- Then: The thread history contains an `input.prompt` event for the Run with the prompt text, and the thread metadata shows selected model `auto`.
