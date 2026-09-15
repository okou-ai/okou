# AWS Sign-In refresh expiry

Firewall auth treats an AWS CLI account's refresh response with HTTP 401 and
the parsed provider code `TOKEN_EXPIRED` as expected credential expiry. It
returns the existing `502 TOKEN_REFRESH_FAILED` / `reconnect_required`
response without credentials and records `needsReconnect=true` with the
existing `credential_expired` reason. The account remains unavailable until
the user reconnects it.

The transition writes no log record. Refresh-failure diagnostics follow one
rule: a `reconnect_required` outcome is silent because the persisted reconnect
state is already the signal an operator and the account owner can read, and an
`upstream_provider` outcome writes one WARN with `accessSourceKey`, `orgId`,
`userId`, `errorCode` and `failureReason`, without provider message text or an
OAuth error echo. The provider code is independent of normalized OAuth
`invalid_grant`; AWS currently normalizes other 4xx responses to that OAuth code
too. Message text alone never selects the expiry policy. Unknown 4xx, 429, 5xx,
transport failures and malformed responses keep their existing handling and are
classified by the same rule. Storage exceptions still propagate through normal
API error reporting; a silent expiry is not a certificate that a database
transaction committed or a run succeeded.

Every refresh checks the selected account's current state under the existing
refresh locks. AWS CLI accounts marked `credential_expired` return the same
reconnect-required result without another provider request, including concurrent
and `forceRefresh` requests. This does not select a healthy sibling or change
the default account. Reconnecting atomically replaces credentials and clears
the reconnect state. Other providers' retry/recovery policies are unchanged.

## Deployment and verification

No database migration, frontend change or runner protocol change is required.
The reason is already supported by existing API and frontend readers. Old rows
with generic reconnect reasons are not assumed to be expired: their next
explicit expiry response establishes the terminal state. An overlapping old
API can still refresh and write its generic reason; the new no-repeat guarantee
applies after API promotion and old requests finish.

Keep [#32756](https://github.com/vm0-ai/vm0/issues/32756) open after merge until
verification records a 24-hour half-open window after that rollout boundary:

- Exercise or observe actual expiry and successful user reconnect. Confirm the
  account's unavailable/connected states and denial of credentials while expired.
- Verify no further AWS refresh attempts for that unchanged expired account
  state, and no expiry-attributable WARN/ERROR logs or Sentry error events.
- Retain actionable diagnostics for a genuine provider or persistence failure.
- Record the deployed API identity, window, sanitized evidence and limitations.
  No matching warning, without expiry traffic, is not verification of the path.

Local route tests cover provider failures, persistence through account reads,
concurrent/repeated requests, multi-account isolation, and reconnect recovery.
They do not inject database statement or commit failure. They are not evidence
that production has been deployed or observed.
