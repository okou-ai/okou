# connector-external-code-session-claim

## connector-external-code-session-claim-001

- Vitest: "external-code session claim ownership > reclaims a rejected reconnect into the exact non-default account without changing its sibling"
- Mode: run
- Given: An authenticated owner has two AWS CLI accounts with distinct provider identities. They start an external-code reconnect for the non-default account, and the first code is rejected by AWS.
- When: The owner submits the code to POST /api/connectors/aws/external-code/sessions/:sessionId/complete, retries the same session with a valid code, and replays after completion.
- Then: The first request returns HTTP 400 BAD_REQUEST instructing the caller to check the rejected external authorization code and try again and both default flags remain unchanged. A successful retry emits the owner's connector change event, returns HTTP 200 complete for the exact connected non-default CLI account and replays the same account. The original default remains, and responses omit session and provider credentials.

## connector-external-code-session-claim-002

- Vitest: "external-code session claim ownership > keeps a reclaimed real session exclusive while enforcing each identity boundary"
- Mode: run
- Given: An authenticated owner has an AWS CLI add session with an earlier rejected code and no account. A retry with a valid code reaches the provider and its response is delayed.
- When: While the retry is in flight at POST /api/connectors/aws/external-code/sessions/:sessionId/complete, callers try the same valid inputs from a different user and a different workspace, a wrong connector, a wrong token, and a duplicate from the actual owner. The provider then returns success.
- Then: The mismatched requests return HTTP 404 NOT_FOUND with External-code authorization session not found. The exact concurrent duplicate returns HTTP 400 BAD_REQUEST with message External-code authorization session is already completing. The in-flight exchange succeeds at HTTP 200, emits a connector change and replays the exact only saved connected default AWS CLI account. Replies omit session and provider credentials.
