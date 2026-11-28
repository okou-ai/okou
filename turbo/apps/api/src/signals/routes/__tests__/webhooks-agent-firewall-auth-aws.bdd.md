# webhooks-agent-firewall-auth-aws

## webhooks-agent-firewall-auth-aws-001

- Vitest: "AWS Sign-In refresh expiry > stops repeated refreshes until the exact account reconnects"
- Mode: run
- Given: A Pro workspace member connected an AWS account through the AWS Sign-In CLI verification-code flow and has a chat Run dispatched with an AWS SigV4 firewall bound to that account. AWS Sign-In now rejects refreshes with HTTP 401 `TOKEN_EXPIRED`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` for the account with `forceRefresh`, without it, and with it again; the member reads the account, reconnects that exact account through the verification-code flow, and the firewall requests a forced refresh once more.
- Then: All three requests return HTTP 502 with `TOKEN_REFRESH_FAILED`, failure reason `reconnect_required` and connector `aws`, and AWS Sign-In is called only once. The account is `reconnect-required` with reason `credential_expired`. Reconnecting keeps the same account ID with status `connected` and no reason, and the next forced refresh returns HTTP 200 with the new SigV4 access key, secret and session token after an authorization-code grant followed by one refresh grant.

## webhooks-agent-firewall-auth-aws-002

- Vitest: "AWS Sign-In refresh expiry > keeps a healthy sibling account usable without substituting it for the expired account"
- Mode: run
- Given: A Pro workspace member has two connected AWS accounts, the original and a sibling identified as a different IAM user, and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects refreshes with HTTP 401 `TOKEN_EXPIRED`.
- When: The Run's firewall sends `POST /api/webhooks/run/firewall/auth` with `forceRefresh` for the original account; the member makes the sibling the default; the firewall then requests the original account and the sibling without forcing a refresh, and the member lists the AWS accounts.
- Then: The original account returns HTTP 502 both times, while the sibling returns HTTP 200, and AWS Sign-In is called only once. The original account is `reconnect-required` with reason `credential_expired` and the sibling stays `connected` with no reason.

## webhooks-agent-firewall-auth-aws-003

- Vitest: "AWS Sign-In refresh expiry > recognizes explicit expiry after an older generic reconnect state"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In first rejects refreshes with HTTP 401 `invalid_grant`, then with HTTP 401 `TOKEN_EXPIRED`.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, the firewall sends two more forced requests after the provider switches to `TOKEN_EXPIRED`, and the member reads the account again.
- Then: The first request returns HTTP 502 and the account's reason is `authorization_expired_or_revoked`. The next two requests return HTTP 502 with only one further AWS Sign-In call, and the account's reason becomes `credential_expired`.

## webhooks-agent-firewall-auth-aws-004

- Vitest: "AWS Sign-In refresh expiry > keeps HTTP 401 INVALID_CLIENT actionable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects the refresh with HTTP 401 code `INVALID_CLIENT` and a message mentioning an expired refresh token, and later recovers.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, and after AWS Sign-In recovers the firewall sends another forced request.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, and the account's reason is not `credential_expired`. The retry returns HTTP 200 with one token request, and the account is `connected`.

## webhooks-agent-firewall-auth-aws-005

- Vitest: "AWS Sign-In refresh expiry > keeps HTTP 400 TOKEN_EXPIRED actionable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects the refresh with HTTP 400 code `TOKEN_EXPIRED`, and later recovers.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, and after AWS Sign-In recovers the firewall sends another forced request.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, and the account's reason is not `credential_expired`. The retry returns HTTP 200 with one token request, and the account is `connected`.

## webhooks-agent-firewall-auth-aws-006

- Vitest: "AWS Sign-In refresh expiry > keeps HTTP 400 undefined actionable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects the refresh with HTTP 400 without a code, only a message mentioning an expired refresh token, and later recovers.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, and after AWS Sign-In recovers the firewall sends another forced request.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `reconnect_required`, and the account's reason is not `credential_expired`. The retry returns HTTP 200 with one token request, and the account is `connected`.

## webhooks-agent-firewall-auth-aws-007

- Vitest: "AWS Sign-In refresh expiry > keeps HTTP 429 TOKEN_EXPIRED actionable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects the refresh with HTTP 429 code `TOKEN_EXPIRED`, and later recovers.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, and after AWS Sign-In recovers the firewall sends another forced request.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and the account's reason is not `credential_expired`. The retry returns HTTP 200 with one token request, and the account is `connected`.

## webhooks-agent-firewall-auth-aws-008

- Vitest: "AWS Sign-In refresh expiry > keeps HTTP 503 TOKEN_EXPIRED actionable and recoverable"
- Mode: run
- Given: A Pro workspace member has a connected AWS account and a chat Run with an AWS SigV4 firewall. AWS Sign-In rejects the refresh with HTTP 503 code `TOKEN_EXPIRED`, and later recovers.
- When: The Run's firewall sends a forced `POST /api/webhooks/run/firewall/auth`, the member reads the account, and after AWS Sign-In recovers the firewall sends another forced request.
- Then: The first request returns HTTP 502 with `TOKEN_REFRESH_FAILED` and failure reason `upstream_provider`, and the account's reason is not `credential_expired`. The retry returns HTTP 200 with one token request, and the account is `connected`.
