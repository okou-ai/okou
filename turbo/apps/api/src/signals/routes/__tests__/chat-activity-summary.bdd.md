# chat-activity-summary

## chat-activity-summary-001

- Vitest: "thread activity summary > enforces run ownership before cache or model exposure"
- Mode: run
- Given: A signed-in member has a chat thread whose Run is executing on a Runner, and the summary model answers with one progress message.
- When: Another user in the same organization, the same user signed into another organization, and the owner with an unknown run ID call `POST /api/chat-threads/:id/activity-summary`; then the owner calls it with the real run ID.
- Then: The three mismatched calls return HTTP 404 and the summary model receives no request. The owner's call returns status `available`, and the model receives exactly one request.

## chat-activity-summary-002

- Vitest: "thread activity summary > returns and caches the complete message batch"
- Mode: run
- Given: A signed-in member has a chat thread whose Run is executing, and the summary model returns three lines: "Preparing the launch checklist", "Reviewing the release evidence" and "Checking the remaining tasks".
- When: The member calls `POST /api/chat-threads/:id/activity-summary` for the Run twice.
- Then: The first response is `available` with the three messages, each using its text as both ID and text. The second response is identical to the first, and the model receives exactly one request.

## chat-activity-summary-003

- Vitest: "thread activity summary > retains activity for tool output PostgreSQL cannot store verbatim"
- Mode: run
- Given: A signed-in member has a chat thread whose Run is executing, and the Sandbox has delivered through `POST /api/webhooks/run/events` a tool call whose ID ends in an emoji, whose long name splits an emoji, and whose command contains a NUL byte and a lone surrogate.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` for the Run.
- Then: The response is `available` with the single message "Preparing the launch checklist", and the model receives exactly one request.

## chat-activity-summary-004

- Vitest: "thread activity summary > rejects a superseded run identity before cached or model output"
- Mode: run
- Given: A signed-in member has summarized a running Run; the member then cancelled it with `POST /api/runs/:id/cancel`, the Sandbox reported completion with exit code 1, and the member sent a follow-up prompt on the same thread that launched a new Run.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` for the old Run and then for the new Run.
- Then: The old Run returns `ineligible` with no messages. The new Run returns `available` for the new run ID, and the model receives two requests in total.

## chat-activity-summary-005

- Vitest: "thread activity summary > captures public tools before results after commentary, without demand generation or history writes"
- Mode: run
- Given: A signed-in member has a running Run whose Sandbox delivered commentary text, private thinking, and a `search` tool call with a query "launch checklist" and a private `api_key`.
- When: The member reads the thread events, calls `POST /api/chat-threads/:id/activity-summary` twice, and reads the thread events again.
- Then: No model request is made before the summary call. The first summary is `available` with "Preparing the launch checklist"; the model input includes the query and the `search` tool name but no private thinking or key. The second summary is identical, the model receives exactly one request, and the thread events are unchanged.

## chat-activity-summary-006

- Vitest: "thread activity summary > orders activity and caches the summary across duplicate and usage events"
- Mode: run
- Given: A signed-in member has a running Run whose Sandbox delivered tool calls with sequence numbers 20 and 19 and then 18.
- When: The member requests a summary with `POST /api/chat-threads/:id/activity-summary`, the Sandbox delivers a repeated call 19, a usage-only record 21 and a late call 17, and the member requests a summary again.
- Then: The model input lists activity in sequence order 18, 19, 20. The second summary is identical to the first, and the model receives exactly one request.

## chat-activity-summary-007

- Vitest: "thread activity summary > bounds the activity window and provider payload on the first summary"
- Mode: run
- Given: A signed-in member has a running Run whose Sandbox delivered 30 tool calls (sequence 30 to 59), each with a 1,000-character CJK command.
- When: The member calls `POST /api/chat-threads/:id/activity-summary`.
- Then: The response is `available`. The model input has at most 16 activity entries totaling at most 16 KiB of UTF-8 JSON, each excerpt is at most 700 characters, and the last entry is sequence 59.

## chat-activity-summary-008

- Vitest: "thread activity summary > shares one claim across concurrent callers"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model holds its reply until released.
- When: The member starts a summary with `POST /api/chat-threads/:id/activity-summary`; while the model works, two more summary calls are made, the Sandbox delivers new tool activity, and the model then returns "Preparing the requested checklist".
- Then: Both concurrent calls return no messages. The first call returns "Preparing the requested checklist" as its first message, and the model receives exactly one request.

## chat-activity-summary-009

- Vitest: "thread activity summary > discards a completion after cancel and never exposes terminal cache"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model holds its reply until released. Row: `cancel`.
- When: The member starts `POST /api/chat-threads/:id/activity-summary`; while the model works, the member cancels the Run with `POST /api/runs/:id/cancel`; the model then returns "This phrase must not revive the run", and the member calls the summary again.
- Then: The in-flight summary returns `ineligible` with no messages. The follow-up summary returns `ineligible` with no messages, and the model receives exactly one request.

## chat-activity-summary-010

- Vitest: "thread activity summary > discards a completion after complete and never exposes terminal cache"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model holds its reply until released. Row: `complete`.
- When: The member starts `POST /api/chat-threads/:id/activity-summary`; while the model works, the Sandbox reports successful completion with `POST /api/webhooks/run/complete` (exit code 0); the model then returns "This phrase must not revive the run", and the member calls the summary again.
- Then: The in-flight summary returns `ineligible` with no messages. The follow-up summary returns `ineligible` with no messages, and the model receives exactly one request.

## chat-activity-summary-011

- Vitest: "thread activity summary > discards a completion after delete and never exposes terminal cache"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model holds its reply until released. Row: `delete`.
- When: The member starts `POST /api/chat-threads/:id/activity-summary`; while the model works, the member deletes the chat thread; the model then returns "This phrase must not revive the run", and the member calls the summary again.
- Then: The in-flight summary returns `ineligible` with no messages. The follow-up summary returns HTTP 404, and the model receives exactly one request.

## chat-activity-summary-012

- Vitest: "thread activity summary > cools down malformed output \"\" without retrying"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model returns the malformed output `""` (empty). Row: `""` (empty).
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-013

- Vitest: "thread activity summary > cools down malformed output \"one\\ntwo\\nthree\\nfour\\nfive\" without retrying"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model returns the malformed output `"one\ntwo\nthree\nfour\nfive"` (five lines). Row: `"one\ntwo\nthree\nfour\nfive"` (five lines).
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-014

- Vitest: "thread activity summary > cools down malformed output \"**Markdown**\" without retrying"
- Mode: run
- Given: A signed-in member has a running Run, and the summary model returns the malformed output `"**Markdown**"`. Row: `"**Markdown**"`.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-015

- Vitest: "thread activity summary > cools down after a completion that spent the whole token… without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model returns a completion that spent the whole token budget (finish reason `MAX_TOKENS`) with a private payload.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-016

- Vitest: "thread activity summary > cools down after a completion that ended on an unoffered… without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model returns a completion that ended on an unoffered tool call with a private payload.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-017

- Vitest: "thread activity summary > cools down after a rejected transport request without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model rejects the transport request with a network error.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-018

- Vitest: "thread activity summary > cools down after a body that timed out mid-stream without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model sends a body whose stream times out mid-stream.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-019

- Vitest: "thread activity summary > cools down after a body that is not JSON without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model returns a body that is not JSON.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-020

- Vitest: "thread activity summary > cools down after an envelope without choices without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model returns a JSON envelope without any candidates.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-021

- Vitest: "thread activity summary > cools down after an exception nothing classified without retrying"
- Mode: run
- Given: A signed-in member has a running Run. Row: the summary model sends a body whose stream fails with an unclassified error carrying a private payload and a source path.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-022

- Vitest: "thread activity summary > keeps a cached summary when the optional key disappears during cooldown"
- Mode: run
- Given: A signed-in member has a running Run and a first summary "Preparing the launch checklist". The Sandbox then delivers a new tool call, and the summary model key is removed.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` again during the cooldown.
- Then: The response is `available` with the same messages as the first summary, and the model receives exactly one request.

## chat-activity-summary-023

- Vitest: "thread activity summary > accepts existing Codex commands and tool results while bounding graphemes"
- Mode: run
- Given: A signed-in member has a running Codex-style Run whose Sandbox delivered a started command, private reasoning, an MCP `search` tool call, and a tool result with text "Found launch owners" and a private image. The summary model returns a family emoji repeated 80 times.
- When: The member calls `POST /api/chat-threads/:id/activity-summary`.
- Then: The first message is the family emoji repeated exactly 60 times. The model input lists activity with sequences 0, 2 and 3, contains no private reasoning or image data, and the last excerpt is "Found launch owners".

## chat-activity-summary-024

- Vitest: "thread activity summary > rejects unauthenticated requests and client-supplied evidence"
- Mode: run
- Given: Authentication fails for an unauthenticated caller; separately a signed-in member has a running Run.
- When: The unauthenticated caller calls `POST /api/chat-threads/:id/activity-summary` without credentials, and the member calls it with the run ID plus an extra `prompt` field.
- Then: The unauthenticated call returns HTTP 401, the call with client-supplied evidence returns HTTP 400, and the summary model receives no request.

## chat-activity-summary-025

- Vitest: "thread activity summary > uses a shared cooldown when the model is unconfigured"
- Mode: run
- Given: A signed-in member has a running Run and the summary model key is not configured.
- When: The member calls `POST /api/chat-threads/:id/activity-summary`, the model becomes configured, and the member calls it again.
- Then: The first response is `available` with no messages, and the second call makes no model request.

## chat-activity-summary-026

- Vitest: "thread activity summary > sends the bounded current task as the only message"
- Mode: run
- Given: A signed-in member's chat Run was launched from a prompt of "current task " repeated 100 times, and the Sandbox delivered the commentary "Public commentary".
- When: The member calls `POST /api/chat-threads/:id/activity-summary`.
- Then: The model input's only message is a `user` message containing the trimmed prompt cut to its first 700 characters, and the first activity excerpt is "Public commentary".

## chat-activity-summary-027

- Vitest: "thread activity summary > captures activity and delivers messages independently of Axiom ingestion"
- Mode: run
- Given: A signed-in member has a running Run, and Axiom ingestion answers HTTP 503. The Sandbox delivers a `bash` tool call and the commentary "Public commentary during the Axiom outage" through `POST /api/webhooks/run/events`.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` and lists the thread events.
- Then: The summary is `available` and the model input's first activity is the `bash` tool. The thread events contain the outage-time commentary.

## chat-activity-summary-028

- Vitest: "thread activity summary > absorbs a rate limit before any summary exists"
- Mode: run
- Given: A signed-in member has a running Run with no summary yet, and the summary model answers HTTP 429 with a private body.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with an empty message list, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-029

- Vitest: "thread activity summary > absorbs upstream unavailability before any summary exists"
- Mode: run
- Given: A signed-in member has a running Run with no summary yet, and the summary model answers HTTP 503 with a private body.
- When: The member calls `POST /api/chat-threads/:id/activity-summary` twice.
- Then: The first response is `available` with no messages, and the second call makes no further model request (exactly one request in total).

## chat-activity-summary-030

- Vitest: "thread activity summary > absorbs provider envelope unavailability before any summary exists"
- Mode: run
- Given: A signed-in member has a running Run with no summary yet. Row: `envelope` — the summary model returns HTTP 200 with a candidate that finished with `ERROR` and an `UNAVAILABLE` error carrying a private body.
- When: The member calls `POST /api/chat-threads/:id/activity-summary`.
- Then: The response is `available` with no messages, and the model receives exactly one request.

## chat-activity-summary-031

- Vitest: "thread activity summary > absorbs provider timeout unavailability before any summary exists"
- Mode: run
- Given: A signed-in member has a running Run with no summary yet. Row: `timeout` — the summary model answers HTTP 504 with a private body.
- When: The member calls `POST /api/chat-threads/:id/activity-summary`.
- Then: The response is `available` with no messages, and the model receives exactly one request.

## chat-activity-summary-032

- Vitest: "thread activity summary > rejects a cancelled run heartbeat before its Runner completes"
- Mode: run
- Given: A signed-in member has a running Run, which the member cancels with `POST /api/runs/:id/cancel`.
- When: The Sandbox sends `POST /api/webhooks/run/heartbeat` for the Run, the member reads `GET /api/runs/queue`, and the Sandbox then reports completion with exit code 1.
- Then: The heartbeat returns HTTP 404, the queue still shows 1 active run, and the completion returns HTTP 200.

## chat-activity-summary-033

- Vitest: "thread activity summary > keeps a cancelled running run's compute until its runner reports completion"
- Mode: run
- Given: A signed-in member has a running Run.
- When: The member reads `GET /api/runs/queue`, cancels the Run with `POST /api/runs/:id/cancel`, reads the queue, the Sandbox delivers a tool call, the member reads the queue and calls `POST /api/chat-threads/:id/activity-summary`, and the Sandbox then reports completion with exit code 1 before a final queue read.
- Then: The queue shows 1 active run before cancellation, after cancellation and after the late activity. The summary returns `ineligible` with no messages. After the completion report the queue shows 0 active runs.
