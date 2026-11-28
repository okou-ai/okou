# chat-events-bootstrap-prefetch

## chat-events-bootstrap-prefetch-001

- Vitest: "chat agent bootstrap prefetch > mounts user memory published through the Sandbox API in matching and independent picks"
- Mode: run
- Given: An entitled member has an initial Run with a user Memory mount and can publish a new Memory version from the Sandbox.
- When: The Sandbox prepares and commits a Memory file, then the owner sends a prompt that launches on its own request and another that waits for a later independent pick.
- Then: The prepare and commit requests return HTTP 200. Both successor dispatches mount the same user Memory storage and the published version.

## chat-events-bootstrap-prefetch-002

- Vitest: "chat agent bootstrap prefetch > preserves a non-default member model preference through prefetch and an independent pick"
- Mode: run
- Given: An entitled member has saved Claude Sonnet 5.5 instead of the default model.
- When: The member sends an initial prompt without specifying a model, then queues another on the busy thread and lets an independent request drain it.
- Then: Both dispatched Runs attribute usage to Claude Sonnet 5.5.

## chat-events-bootstrap-prefetch-003

- Vitest: "chat agent bootstrap prefetch > uses the captured Workflow for the sending pick and the newer version for an independent pick"
- Mode: run
- Given: An entitled member owns a published workflow and an attachment whose metadata response can be delayed.
- When: The member starts a send with the attachment and publishes new workflow text while it prepares, then queues another prompt on the resulting thread and lets a later request pick it.
- Then: The first dispatch mounts a Skill bundle containing only the originally published `SKILL.md`. The later independent dispatch mounts a different bundle digest and the newer workflow text.

## chat-events-bootstrap-prefetch-004

- Vitest: "chat agent bootstrap prefetch > loads the same read-only context when a later request drains queued input"
- Mode: run
- Given: An entitled member has an active Claude Fable 5.1 thread and a personal Claude OAuth model source.
- When: The member queues another prompt and cancels and completes the anchor in a separate request.
- Then: The original client input gets a launched replacement. The promoted Run is claimable and reads back the same Fable model and Claude OAuth provider type.

## chat-events-bootstrap-prefetch-005

- Vitest: "chat agent bootstrap prefetch > preserves the custom account through prefetch and a later independent pick"
- Mode: run
- Given: An entitled member has a configured custom HTTP connector with an account and is authorized to use it in the thread.
- When: The member sends one prompt and queues a continuation on that busy thread, then frees it for an independent pick.
- Then: The first and independently picked dispatches both contain the same exact custom connector runtime target and account.

## chat-events-bootstrap-prefetch-006

- Vitest: "chat agent bootstrap prefetch > keeps the captured model selection when the member preference changes during attachment resolution"
- Mode: run
- Given: An entitled member selects personal Claude Fable 5.1 in a send with an attachment whose metadata response is delayed.
- When: While object lookup is outstanding, the member switches their default to Auto, then the metadata response arrives.
- Then: The resulting Run is claimable and its readback still identifies Fable 5.1 on the member-scoped Claude OAuth provider.

## chat-events-bootstrap-prefetch-007

- Vitest: "chat agent bootstrap prefetch > continues the predecessor session with the Memory it published during follow-up preparation"
- Mode: run
- Given: An entitled member has a running Fable session and an attachment for a follow-up with delayed metadata.
- When: While the follow-up prepares, the Sandbox commits a new Memory version and completes the predecessor with its session ID. The attachment metadata then arrives.
- Then: The send returns HTTP 201 and the event referencing its client ID launches. The successor dispatch resumes the exact predecessor session and Run generation and mounts the Memory storage and the version published during preparation.

## chat-events-bootstrap-prefetch-008

- Vitest: "chat agent bootstrap prefetch > preserves the queued input and claimable run through web"
- Mode: run
- Given: An entitled member is authenticated in Web Chat and supplies a client event ID.
- When: The member sends a prompt and reads the thread and resulting Run before the Runner claims it.
- Then: The send returns HTTP 201. Thread events include the Run-associated replacement of that client ID, Run readback has the original prompt, metadata has the response thread ID, and Runner dispatch includes an Okou token.

## chat-events-bootstrap-prefetch-009

- Vitest: "chat agent bootstrap prefetch > preserves the queued input and claimable run through cli"
- Mode: run
- Given: An entitled member has a CLI bearer token and supplies a client event ID.
- When: The member sends a prompt using that token, then reads the resulting thread and Run before Runner claim.
- Then: The send returns HTTP 201. The input has a Run-associated replacement by client ID, the Run readback has the original prompt, metadata matches the returned thread ID, and Runner dispatch includes an Okou token.

## chat-events-bootstrap-prefetch-010

- Vitest: "chat agent bootstrap prefetch > uses the selected default account for each successive pick"
- Mode: run
- Given: An entitled member has two OpenAI accounts with the first selected as the default.
- When: The member sends and claims a Run, changes the default to the second account, and sends and claims another.
- Then: The first dispatch's OpenAI credential reference identifies the first account and the second dispatch identifies the newly selected account.

## chat-events-bootstrap-prefetch-011

- Vitest: "chat agent bootstrap prefetch > delivers a steer input to the active authenticated Runner"
- Mode: run
- Given: An entitled member has an active Run on an authenticated Runner group.
- When: The member sends a new input into the active thread and the Sandbox polls for steering.
- Then: The realtime provider receives an `active-input` hint with the active Run ID on that Runner group's channel. Polling returns the exact queued client event ID and prompt.
