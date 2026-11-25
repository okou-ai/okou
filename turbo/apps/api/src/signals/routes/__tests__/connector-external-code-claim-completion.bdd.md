# connector-external-code-claim-completion

## connector-external-code-claim-completion-001

- Vitest: "Builtin external-code claimed completion > retries HTTP rejections into the exact non-default account and preserves both accounts through completed replay"
- Mode: run
- Given: An authenticated owner has distinct default and non-default AWS CLI accounts. A reconnect for the non-default account encounters an invalid code and then transient provider HTTP 429 and 503 responses before provider success.
- When: The owner repeats POST /api/connectors/aws/external-code/sessions/:sessionId/complete with the same session and finally replays completion.
- Then: The invalid code returns HTTP 400 BAD_REQUEST instructing the caller to check the rejected external authorization code and try again. The two transient failures return HTTP 500 Internal server error. No failure alters either account's role. Recovery returns HTTP 200 complete for the exact non-default account and subsequent replay is identical. Responses omit secrets.

## connector-external-code-claim-completion-002

- Vitest: "Builtin external-code claimed completion > keeps malformed provider success terminal and recovers only with a new public session"
- Mode: run
- Given: An authenticated owner starts an AWS CLI external authorization session. The provider's token exchange reports HTTP success but supplies an empty body object.
- When: The owner calls POST /api/connectors/aws/external-code/sessions/:sessionId/complete twice with the same session and then starts and completes a new session.
- Then: The malformed success first returns HTTP 500 Internal server error. Replay of the failed session returns HTTP 400 BAD_REQUEST with a message beginning Invalid AWS Sign-In token response. No account is saved before recovery. The new session completes over HTTP 200 with its sole new default account and replays identically without secrets.

## connector-external-code-claim-completion-003

- Vitest: "Builtin external-code claimed completion > returns the original late provider HTTP 400 outcome after strict stale expiry without publishing an account"
- Mode: run
- Given: An authenticated owner starts an AWS external-code session whose deadline comes before the 30-minute staleness threshold. The provider holds the first exchange, which will finish with HTTP 400 invalid_grant.
- When: The owner repeats POST /api/connectors/aws/external-code/sessions/:sessionId/complete exactly 30 minutes after the claim and one millisecond later, then releases the original provider error and retries again.
- Then: The exact threshold returns HTTP 400 BAD_REQUEST with message External-code authorization session is already completing. A millisecond later and after the old response, retries return HTTP 400 BAD_REQUEST with message External-code authorization session expired. The original request returns HTTP 400 BAD_REQUEST instructing the caller to check the rejected external authorization code and try again. No account is published and responses omit secrets.

## connector-external-code-claim-completion-004

- Vitest: "Builtin external-code claimed completion > returns the original late provider HTTP 503 outcome after strict stale expiry without publishing an account"
- Mode: run
- Given: An authenticated owner starts an AWS external-code session whose deadline comes before the 30-minute staleness threshold. The provider holds the first exchange, which will finish with HTTP 503 temporarily_unavailable.
- When: The owner repeats POST /api/connectors/aws/external-code/sessions/:sessionId/complete exactly 30 minutes after the claim and one millisecond later, then releases the original provider error and retries again.
- Then: The exact threshold returns HTTP 400 BAD_REQUEST with message External-code authorization session is already completing. A millisecond later and after the old response, retries return HTTP 400 BAD_REQUEST with message External-code authorization session expired. The original request returns HTTP 500 Internal server error. No account is published and responses omit secrets.
