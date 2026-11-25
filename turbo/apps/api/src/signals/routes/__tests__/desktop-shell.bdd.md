# desktop-shell

## desktop-shell-001

- Vitest: "Desktop Shell command pipeline > publishes committed chat_busy authorization when the immediate pick acquires the chat slot"
- Mode: run
- Given: Row `immediate`. A member has the Desktop Shell feature switch on and a connected Desktop computer advertising Shell capabilities. A Run on that computer requested Shell access via `POST /api/computer-use/shell/authorizations` and was then cancelled, so the request reads `pending` with `approvalBlockedReason: null`.
- When: The member sends a new message to the chat with `POST /api/chat/events`, which immediately launches the next Run.
- Then: The next Run launches. When the `desktopShellAuthorizationChanged` realtime notification is published, `GET /api/computer-use/shell/authorizations/:id` already reads `chat_busy`; afterwards it reads `pending` with `approvalBlockedReason: "chat_busy"`, and `POST /api/computer-use/shell/authorizations/:id/approve` returns HTTP 409.

## desktop-shell-002

- Vitest: "Desktop Shell command pipeline > publishes committed chat_busy authorization when the queued pick acquires the chat slot"
- Mode: run
- Given: Row `queued`. A member has the Desktop Shell switch on and a Desktop computer with Shell capabilities; a cancelled Run left a `pending` Shell access request with no blocking reason. A new Run occupies the chat and a further message is queued behind it without a Run.
- When: The member cancels the blocking Run so the queued message acquires the chat slot.
- Then: The queued message launches its Run. When `desktopShellAuthorizationChanged` is published, the authorization already reads `chat_busy`; it then reads `pending` with `approvalBlockedReason: "chat_busy"`, and approving it returns HTTP 409.

## desktop-shell-003

- Vitest: "Desktop Shell command pipeline > notifies the owner when cloud browser changes the computer for a pending Shell approval"
- Mode: run
- Given: Row `cloud browser`. A member has the Desktop Shell switch on and a Desktop computer; a Run on it requested Shell access and created a cloud browser authorization request via `POST /api/browser/authorization-requests` with its sandbox token, then was cancelled, leaving the Shell request `pending` with no blocking reason.
- When: The member applies the browser request with `POST /api/browser/authorization-requests/:requestToken/apply`.
- Then: Exactly one `desktopShellAuthorizationChanged` notification is observed, at which point the request reads `approvalBlockedReason: "computer_changed"`; it is sent on the member's `user:<userId>` channel, and approving the Shell request returns HTTP 409.

## desktop-shell-004

- Vitest: "Desktop Shell command pipeline > notifies the owner when another computer changes the computer for a pending Shell approval"
- Mode: run
- Given: Row `another computer`. A member has the Desktop Shell switch on and a Desktop computer; a Run on it requested Shell access and created a computer selection request via `POST /api/computer-use/authorization-requests`, a second Desktop computer connected, and the Run was cancelled, leaving the Shell request `pending` with no blocking reason.
- When: The member applies the selection request to the second computer with `POST /api/computer-use/authorization-requests/:requestToken/apply`.
- Then: Exactly one `desktopShellAuthorizationChanged` notification is observed with the request reading `computer_changed`, sent on the member's `user:<userId>` channel, and approving the Shell request returns HTTP 409.

## desktop-shell-005

- Vitest: "Desktop Shell command pipeline > notifies the owner when queued send changes the computer for a pending Shell approval"
- Mode: run
- Given: Row `queued send`. A member has the Desktop Shell switch on and two connected Desktop computers; a Run on the first requested Shell access and was cancelled. The member then sent a message that occupies the chat, so the request reads `chat_busy`.
- When: The member sends another message with `POST /api/chat/events` naming the second computer in `computerUseHostId`.
- Then: The new message does not launch a Run yet. Exactly one `desktopShellAuthorizationChanged` notification is observed with the request reading `computer_changed`, sent on the member's `user:<userId>` channel, and approving the Shell request returns HTTP 409.

## desktop-shell-006

- Vitest: "Desktop Shell command pipeline > scopes approval to the owning chat and computer, and only accepts human decisions"
- Mode: run
- Given: Two members have the Desktop Shell switch on. The first member's Run requested Shell access (approval blocked with `run_active` and HTTP 409 while it ran), the Run was cancelled, the member approved it with a one-hour grant, and a follow-up message launched a new Run.
- When: The other member reads and revokes the authorization; the Run token approves it; the member requests access and creates Shell commands (`POST /api/computer-use/shell/commands`) with their session and a CLI token; a Run in a second chat on the same computer creates a command and requests access; that Run is cancelled and the member moves the chat to a second computer via `POST /api/chat-threads/:id/computer-use-host`; the member then approves, denies, and approves the second request.
- Then: The other member gets HTTP 404 for read and revoke; the Run token gets HTTP 403 when approving; the member's direct access request and the session, CLI-token, and second-chat commands get HTTP 403. Moving the computer publishes `desktopShellAuthorizationChanged` and the request reads `computer_changed`; approval returns HTTP 409 before and after the deny, while the deny succeeds.

## desktop-shell-007

- Vitest: "Desktop Shell command pipeline > revokes queued work without cancelling already claimed work or closing terminals"
- Mode: run
- Given: A member approved Shell access for a Run on a Desktop computer. The Run started `shell.cmd` `sleep 300`, which the computer claimed, and queued a `shell.status` command.
- When: The member revokes the authorization twice; the computer completes the claimed command with an open session; the Run reads both commands and tries `shell.list`, `shell.close` (all), and `shell.cmd` on the session; the member approves a new request, and the new Run sends `yes\n` to the existing terminal.
- Then: Both revokes succeed. The claimed command reads `succeeded` with the session still `open`; the queued one reads `failed` with `permission_denied`; the three new commands return HTTP 403. The renewed authorization has a new ID, the computer's next claim is `idle`, and the terminal input returns HTTP 200 and is claimed with `sessionId`, `input: "yes\n"`, and the `shellPermissionId`.

## desktop-shell-008

- Vitest: "Desktop Shell command pipeline > expires grants at the dispatch boundary and expires unapproved requests separately"
- Mode: run
- Given: A member approved Shell access for a Run on a Desktop computer. One millisecond before the grant expires, the computer heartbeats and the Run queues a `shell.list` command.
- When: The clock reaches the grant expiry and the computer claims work; the Run reads the command, creates another command, and requests new access; the Run is cancelled, the clock advances to the new request's `requestExpiresAt`, and the member approves it.
- Then: The queued command returns HTTP 200 before expiry, the claim at expiry is `idle`, the command reads `failed` with `permission_denied`, and the authorization reads `expired`. The new command returns HTTP 403 and the new request has a different ID. Approving it at its request expiry returns HTTP 410, and it reads `expired` with `grantExpiresAt: null`.

## desktop-shell-009

- Vitest: "Desktop Shell command pipeline > uses the authorized computer, explicit local capabilities and the existing result channel"
- Mode: run
- Given: A member connects a Desktop computer advertising Shell capabilities without accessibility or screen-recording permissions; the Desktop Shell switch is initially off.
- When: The member creates `shell.list` via `POST /api/computer-use/shell/commands`; after turning the switch on, an unauthorized Run tries the same; after approval the Run creates realtime `shell.cmd` `pwd`, the computer claims it and completes it first with an invalid result and then with a running-session result; the Run queues `shell.list`, and the switch is toggled off, on, and off.
- Then: The member's command and the unauthorized Run get HTTP 403 (the latter with `SHELL_AUTHORIZATION_REQUIRED`) and the computer stays `idle`. The `pwd` command publishes `commandsChanged` and is claimed by that computer as `shell.cmd` with `timeoutMs: 16000` and the command, `waitMs`, and `shellPermissionId`. The invalid completion returns HTTP 400 leaving it `running`; the valid one makes it `succeeded` with `commandState: "running"`. Turning the switch off fails the queued command with `permission_denied`, re-enabling leaves the claim `idle`, and with the switch off a new command returns HTTP 403.

## desktop-shell-010

- Vitest: "Desktop Shell command pipeline > never routes shell work to old hosts with empty capabilities or an unbound run"
- Mode: run
- Given: A member has the Desktop Shell switch on and an older Desktop computer that advertises no capabilities.
- When: A Run bound to the old computer creates `shell.list` via `POST /api/computer-use/shell/commands`, the old computer claims work, and a Run with no bound computer creates the same command.
- Then: The bound Run gets HTTP 409, the old computer's claim is `idle`, and the unbound Run gets HTTP 403.
