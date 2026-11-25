# chat-events-model-routing

## chat-events-model-routing-001

- Vitest: "CHAT-02: model-first routing > adds Codex image upload guidance for web chat Codex sends"
- Mode: run
- Given: A Web workspace member has a personal Astra route using native Codex.
- When: The member sends an image-generation prompt and a Runner claims the Run.
- Then: Dispatch uses Codex and the system prompt's ordered sections are Identity, Execution Time Limit, Agent Tools, Current User Info and Current Integration before Web image upload guidance. Web Gmail guidance includes sender lookup, multipart draft formatting, signature handling, a review link without a callback, send confirmation and no automatic follow-up send.

## chat-events-model-routing-002

- Vitest: "CHAT-02: model-first routing > queues an existing-thread input with its model until the active run releases the thread"
- Mode: run
- Given: A Fable Run already occupies an existing thread and the owner can use paid personal Claude Fable.
- When: The member submits another prompt with its model and client event ID, then cancels and completes the current Run.
- Then: The send returns HTTP 201 and the input remains visible without a replacement while the thread is occupied. The picked replacement has a Run after release, and dispatch attributes usage to Fable 5.1.

## chat-events-model-routing-003

- Vitest: "CHAT-02: model-first routing > rejects personal model gpt-6-luna without the caller's subscription"
- Mode: run
- Given: A signed-in workspace member has no connected subscription granting personal GPT-6 Luna.
- When: The member tries creating a thread selecting that model.
- Then: Thread creation returns HTTP 400 with an API error.

## chat-events-model-routing-004

- Vitest: "CHAT-02: model-first routing > rejects the internal Auto run model as a send selection"
- Mode: run
- Given: A workspace member owns a Fable thread and has the internal Auto execution identity `okou-1.0`.
- When: The member submits that identity as an explicit model for both a new send and a send to the existing thread.
- Then: Both sends return HTTP 400 with unknown model `okou-1.0`. Existing thread metadata still selects Fable.

## chat-events-model-routing-005

- Vitest: "CHAT-02: model-first routing > stores canonical Auto when the first send omits a model with no member preference"
- Mode: run
- Given: A member has no saved default model and workspace capacity is occupied by another Run.
- When: The member sends to a new client thread ID without a model field.
- Then: The send returns HTTP 201 with that thread ID. Metadata and the creation event use canonical Auto, and public history contains one matching structured input with no Run ID while it waits.

## chat-events-model-routing-006

- Vitest: "CHAT-02: model-first routing > switches a subscription-pinned thread to Auto when a send selects null"
- Mode: run
- Given: A member has a subscription-pinned thread and workspace capacity is full.
- When: The member sends to that thread with explicit null model.
- Then: The send returns HTTP 201 with the same thread ID. Metadata and the model-selection update use Auto, while exactly one queued input with the client's document waits without a Run ID.

## chat-events-model-routing-007

- Vitest: "CHAT-02: model-first routing > rejects a disconnected thread subscription until its owner explicitly selects Auto"
- Mode: run
- Given: A workspace member has completed a Fable Run on a thread and then disconnects its personal Claude subscription.
- When: The member submits another prompt without changing the stored model, then explicitly switches the thread to Auto.
- Then: The continuation is rejected as conflict during pick with no Run ID while metadata retains Fable. Explicit Auto updates metadata and publishes an Auto selection event.

## chat-events-model-routing-008

- Vitest: "CHAT-02: model-first routing > rejects a requested retired Claude alias once its subscription account is deleted"
- Mode: run
- Given: A member owns a thread selecting Fable 5.1, then deletes their Claude subscription.
- When: The member sends using the retired Fable 5 alias.
- Then: HTTP 400 explains the Fable 5.1 replacement and directs the member to select Auto or connect Claude. The thread event list and selected Fable 5.1 model remain unchanged.

## chat-events-model-routing-009

- Vitest: "CHAT-02: model-first routing > keeps the enqueued model after thread and member defaults change"
- Mode: run
- Given: A member owns a busy historical Fable thread and still has the Fable subscription.
- When: The member queues another input, changes both default and thread model to Auto, and completes the first Run.
- Then: The promoted prompt uses Claude Code with Fable 5.1. Thread metadata stays Auto and the explicit Auto selection remains the sole non-Fable model update in thread events.

## chat-events-model-routing-010

- Vitest: "CHAT-02: model-first routing > does not overwrite a concurrent explicit thread model selection"
- Mode: run
- Given: An entitled member owns a thread with Fable available and an Auto member default.
- When: A send selecting Auto races an explicit model-selection write for Fable. The member then sends another prompt with no model override.
- Then: The write returns HTTP 204 and the send returns HTTP 201. The raced Run may use Auto or Fable, but the later prompt dispatches with Fable. The feed has one explicit Fable update and at most one null-model update.

## chat-events-model-routing-011

- Vitest: "CHAT-02: model-first routing > launches Ultrafast without probing the selected Codex subscription"
- Mode: run
- Given: A member has a personal Codex auth.json account eligible for GPT-6.1 Sol and Ultrafast is initially disabled.
- When: The member reads the model catalog, enables the Ultrafast switch, reads again and sends a Sol prompt with Ultrafast.
- Then: The catalog omits availability at first, then exposes priority and Ultrafast availability. The Run dispatches on Pi with the ultrafast tier. Neither action calls the provider's Codex model endpoint.

## chat-events-model-routing-012

- Vitest: "CHAT-02: model-first routing > passes Fast only on a supported personal Codex route"
- Mode: run
- Given: A member has personal Codex access for GPT-6 Sol and GPT-6.1 Sol and personal Claude Sonnet access.
- When: They send fast Sol, attempt to switch its thread to fast Sonnet, explicitly clear tier while switching to Sonnet, then send standard GPT-6.1 Sol. They also try creating a fresh thread by sending Sonnet with Fast.
- Then: Fast Sol uses Pi on Codex with fast tier, while the thread and input model part show priority. Failed Fast Sonnet selection returns HTTP 400 and retains priority. Clearing Fast records a Sonnet selection and null tier alongside the prior creation event. The standard Sol turn has no tier in metadata, model annotation or Pi config. A fresh Fast Sonnet send returns HTTP 400 and its proposed thread is absent.
