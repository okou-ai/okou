# chat-events-pi-codex-credentials

## chat-events-pi-codex-credentials-001

- Vitest: "Pi Codex subscription admission > does not admit a new personal run after its only account is deleted"
- Mode: run
- Given: An entitled member had one connected Codex account and then deletes it.
- When: The member submits a Luna Chat prompt and reads the thread event history after admission.
- Then: The send returns HTTP 201. Its client event is replaced by an `input.rejected` conflict instead of a Run, and one `output.error` tells the member to reconnect the unavailable account. The deleted account identity is absent from the event history.

## chat-events-pi-codex-credentials-002

- Vitest: "ChatGPT subscription credentials at launch > launches gpt-6-luna when stored-secret decryption is unavailable"
- Mode: run
- Given: An entitled member has a connected personal ChatGPT account, with stored-secret decryption unavailable.
- When: The member selects Luna and sends a prompt.
- Then: The prompt launches and exposes a Run ID despite the decryption outage.

## chat-events-pi-codex-credentials-003

- Vitest: "ChatGPT subscription credentials at launch > launches gpt-6-astra when stored-secret decryption is unavailable"
- Mode: run
- Given: An entitled member has a connected personal ChatGPT account, with stored-secret decryption unavailable.
- When: The member selects Astra and sends a prompt.
- Then: The prompt launches and exposes a Run ID despite the decryption outage.

## chat-events-pi-codex-credentials-004

- Vitest: "ChatGPT auth.json credentials at launch > launches gpt-6-luna with KMS decryption unavailable beside a connected Claude subscription"
- Mode: run
- Given: An entitled member has a connected Claude subscription and a ChatGPT `auth.json` source with a workspace account ID. Stored-secret decryption is unavailable.
- When: The member selects Luna and sends a prompt.
- Then: The prompt launches and exposes a Run ID.

## chat-events-pi-codex-credentials-005

- Vitest: "ChatGPT auth.json credentials at launch > launches gpt-6-astra with KMS decryption unavailable beside a connected Claude subscription"
- Mode: run
- Given: An entitled member has a connected Claude subscription and a ChatGPT `auth.json` source with a workspace account ID. Stored-secret decryption is unavailable.
- When: The member selects Astra and sends a prompt.
- Then: The prompt launches and exposes a Run ID.

## chat-events-pi-codex-credentials-006

- Vitest: "ChatGPT auth.json credentials at launch > fails closed when a ChatGPT auth.json has no account id"
- Mode: run
- Given: An entitled member has a ChatGPT `auth.json` that omits the workspace account ID.
- When: The member tries connecting that source and then submits a prompt requesting Astra.
- Then: Storing the malformed source returns HTTP 400 with `CODEX_AUTH_JSON_SHAPE_INVALID`. The prompt enqueue returns HTTP 201 and does not trigger any stored-secret decrypt call.
