# connector-external-code-session-read

## connector-external-code-session-read-001

- Vitest: "external-code owned-session read > rejects each real-session identity boundary before and after completion"
- Mode: run
- Given: An authenticated owner starts an AWS CLI external-code add session. No AWS account is saved and the provider will exchange its valid code.
- When: Using POST /api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete before and after valid completion, callers test a wrong token, wrong connector, a different user in the same workspace and the same user in another workspace. The owner also repeats valid completion and lists the accounts.
- Then: Every mismatched request returns HTTP 404 NOT_FOUND with message External-code authorization session not found and no session or provider secrets. No account is created by rejected attempts. Valid completion and replay return HTTP 200, the exact same connected AWS CLI account and no secrets. The default and only saved account is that ID.

## connector-external-code-session-read-002

- Vitest: "external-code owned-session read > requires each exact token across real supersession and completed-account replay"
- Mode: run
- Given: An authenticated owner starts two AWS CLI external-code add sessions. The second supersedes the first and receives a distinct ID and token.
- When: The owner sends POST /api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete with each swapped ID/token pair and the first valid pair, completes the second session, then repeats the same checks and replays the second valid pair.
- Then: Crossed pairs return HTTP 404 NOT_FOUND. The first valid pair returns HTTP 400 BAD_REQUEST stating the session was superseded. These requests leave the account list empty before latest-session completion. The second valid pair completes and replays under HTTP 200 for the same connected AWS CLI account, the only one listed, with no session or provider credentials exposed.
