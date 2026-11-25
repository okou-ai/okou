# computer-use-command-get

## computer-use-command-get-001

- Vitest: "GET /api/computer-use/commands/:commandId > preserves session, PAT and supported Agent auth with exact owner and host isolation"
- Mode: run
- Given: A signed-in workspace member has two registered Desktop hosts. An Agent in a chat Run bound to the first host created an `app.open` Safari write command. The member also has a personal access token; other Agent tokens exist for a Run bound to the second host and for a Run with no host; a same-workspace peer and a member of another workspace are signed in.
- When: Each caller requests `GET /api/computer-use/commands/:commandId` for the command.
- Then: Requests without credentials or without an organization return HTTP 401 with an API error. The member session, the personal access token and the bound Agent token return identical command bodies. The Agent bound to the other host gets HTTP 404 `{ error: { message: "Computer-use command not found", code: "NOT_FOUND" } }`, the Agent without a host gets HTTP 403 with an API error, and the peer and the other-workspace member both get the same 404 body.

## computer-use-command-get-002

- Vitest: "GET /api/computer-use/commands/:commandId > preserves queued, running, succeeded, failed and offloaded response fields"
- Mode: run
- Given: A signed-in member has a registered Desktop host named "Projection Desktop", and screenshot storage accepts uploads.
- When: The member creates an `app.state` read command for Safari (15 s timeout) via `POST /api/computer-use/commands` and reads `GET /api/computer-use/commands/:commandId` while queued, after the Desktop claims it, and after the Desktop completes it with visible text and a PNG screenshot; then creates an `app.open` Finder write command that the Desktop fails with `app_not_found`, and reads it.
- Then: The queued read returns exactly the ID, kind, `queued` status, host ID and name, `{ app: "Safari" }` payload, 15000 ms timeout, creation time and null claim/completion times. The running read shows `running` with the claim time. The succeeded read returns the snapshot ID, the Unicode visible text and a screenshot reference `{ type: "s3", mimeType: "image/png", sizeBytes, width: 1280, height: 720 }` without the base64 bytes, with exactly one upload stored. The failed read returns `failed` with the `app_not_found` error and Unicode message and no `result` field.

## computer-use-command-get-003

- Vitest: "GET /api/computer-use/commands/:commandId > fails a running command once it passes its timeout, audits it once and keeps late completions from overwriting it"
- Mode: run
- Given: A signed-in member's Desktop host has claimed an Agent-issued `app.open` command with a 1000 ms timeout.
- When: The member reads `GET /api/computer-use/commands/:commandId` at +500 ms; at +2000 ms two reads run concurrently with a Desktop poll for the next command; then the member reads again, lists the command's audit events, and the Desktop sends a late successful completion.
- Then: At +500 ms the command is `running`. At +2000 ms the Desktop poll returns `idle`, both concurrent reads report `running` or `failed`, and the next read returns `failed` with code `timeout`, message "Computer-use command timed out after 1000ms" and completion time +2000 ms. Exactly one audit event exists for the command, and after the late completion the command is still `failed`.

## computer-use-command-get-004

- Vitest: "GET /api/computer-use/commands/:commandId > lets Desktop polling expire a blocker after the strict timeout boundary and preserves its audit through late completions"
- Mode: run
- Given: A signed-in member's Desktop host has claimed an Agent-issued Safari `app.open` command with a 1000 ms timeout, and the Agent has queued a Finder `app.open` successor.
- When: The Desktop polls for the next command at exactly +1000 ms and again at +2000 ms; the member reads the blocked command and its audit events; then the Desktop sends a late success and a late `app_not_found` failure for the blocker and completes the successor.
- Then: At +1000 ms the poll returns `idle`, the blocker is still `running` with no completion time, and it has no audit events. At +2000 ms the poll delivers the successor as `running`, the blocker reads `failed` with code `timeout` ("Computer-use command timed out after 1000ms") completed at +2000 ms, and a single `completed` audit event records the Run, host, kind, app, null result, the timeout error and that time. Late completions leave the blocker and its audit unchanged, and the successor becomes `succeeded`.
