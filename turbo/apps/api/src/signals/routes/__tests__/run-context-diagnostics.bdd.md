# run-context-diagnostics

## run-context-diagnostics-001

- Vitest: "masks API-only data router credentials in captured diagnostics"
- Mode: run
- Given: A Pro member with a personal subscription model launches a Run while the data router is configured; the API-only `OKOU_DATA_TOKEN` has the same value as the admitted app URL. Run context diagnostics are captured to the diagnostic store.
- When: The Runner reads the execution input and the member requests `GET /api/runs/:id/context`.
- Then: The context returns HTTP 200 with the execution's prompt and appended system prompt, `OKOU_APP_URL` masked as `***`, and secret names including `OKOU_TOKEN` and `OKOU_DATA_TOKEN`. The execution itself receives the real app URL, while the context's environment never contains that value and the body never contains the Run's Okou token.

## run-context-diagnostics-002

- Vitest: "masks API-only Preview credentials in captured diagnostics"
- Mode: run
- Given: A Pro member with a personal subscription model sends a chat message in a Preview deployment using a valid Vercel protection bypass header; the API-only `VERCEL_AUTOMATION_BYPASS_SECRET` has the same value as the admitted app URL. Run context diagnostics are captured to the diagnostic store.
- When: The Runner reads the execution input and the member requests `GET /api/runs/:id/context`.
- Then: The context returns HTTP 200 with the execution's prompt and appended system prompt, `OKOU_APP_URL` masked as `***`, and secret names including `OKOU_TOKEN` and `VERCEL_AUTOMATION_BYPASS_SECRET`. The execution itself receives the real app URL, while the context's environment never contains that value and the body never contains the Run's Okou token.

## run-context-diagnostics-003

- Vitest: "reads captured diagnostics through uppercase Run UUID paths"
- Mode: run
- Given: A Pro member has launched a Run whose captured diagnostics include appended instructions.
- When: The member requests `GET /api/logs/:id` and `GET /api/runs/:id/context` using the Run ID in upper case.
- Then: The log returns HTTP 200 with the canonical lower-case Run ID and the captured appended system prompt. The context returns HTTP 200 with the business prompt, the captured appended system prompt and empty `vars`.

## run-context-diagnostics-004

- Vitest: "distinguishes captured empty values from historically unavailable diagnostic fields"
- Mode: run
- Given: A Pro member has launched a Run whose captured diagnostics are replaced in turn by: an empty prompt with empty variable entries; a prompt with absent or null variable entries; a capture missing the prompt; and no capture at all.
- When: The member requests `GET /api/runs/:id/context` after each change.
- Then: The empty capture returns an empty prompt, the captured instructions and `vars` `{}`. Absent or null variable entries return the historical prompt with `vars` null. A capture without a prompt returns HTTP 404, and a missing capture returns HTTP 404.

## run-context-diagnostics-005

- Vitest: "keeps ownership and business reads independent of unavailable diagnostic storage"
- Mode: run
- Given: A Pro member has launched a Run, and the diagnostic store is unavailable. A colleague in the same organization and an outsider also sign in.
- When: The colleague and outsider request the Run context and the colleague requests `GET /api/logs/:id`; the owner reads the Run, the log, and `GET /api/runs/:id/context`.
- Then: The colleague and outsider get HTTP 404 for the context and the colleague gets 404 for the log. The owner reads the Run as `running` with its business prompt, and the log returns HTTP 200 with framework `claude-code` and `appendSystemPrompt` null. The owner's context request returns HTTP 500.
