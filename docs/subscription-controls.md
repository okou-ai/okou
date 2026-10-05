# Personal subscription CLI and Reset Cards

`okou subscription` operates on concrete personal Claude Code and Codex
subscription account IDs, not model route IDs, emails, or list positions.
Accounts remain scoped to the authenticated user in the current organization.

## Commands

```sh
okou subscription list --json
okou subscription show <subscription-id> --json
okou subscription reset-link <subscription-id>
okou subscription switch <subscription-id> --json
```

- `list` returns provider counts and every connected account, including its
  active state, account metadata, live five-hour and weekly usage windows,
  natural reset times, remaining reset credits and their next expiry.
- `show` refreshes only the named account. Missing upstream usage and credit
  data remain unknown, never zero. Reset credits mean remaining redemptions,
  not a historical reset count.
- `reset-link` reads the account and produces a trusted platform URL for a
  supported Codex account. It performs no reset. The CLI has no reset execution
  command. Return the URL unchanged so Web Chat can recognize the Reset Card.
- `switch` calls the existing exact-account activation endpoint. Its output
  explains the existing behavior: only subsequent unpinned runs use the new
  default for that provider. Running runs keep their captured account. The
  selected model, explicitly pinned accounts, and other providers do not change.

## Reset Card

A URL has the form `/subscriptions/<account-id>/reset?idempotencyKey=<uuid>`.
The URL is an action descriptor, not an authentication token. The card and its
standalone authenticated page read live account information from the API.
Neither rendering, opening, nor refreshing the URL submits a reset.

Only the user's Reset click sends the existing account-specific reset request.
The request always uses the account ID and idempotency key in the original
URL, even if another account becomes active. Repeated occurrences in one
thread share action signals; in-flight confirmation is serialized. A retry
retains the original key, including when a lost response may have consumed the
last credit. Cross-page and cross-device idempotency belongs to the existing
upstream reset operation.

The fixed outer chat-card frame remains mounted across loading, unavailable,
error, refresh and terminal states. The card shows five-hour and weekly
remaining usage and reset times, available reset credits, and their next
expiry. Unknown quota disables a new reset until a fresh read is available.
Unavailable, disconnected, or foreign accounts cannot be used through the link.

Claude Code exposes usage and natural recovery times, but does not support
manual reset. `subscriptionResetSupported` expresses the provider capability
independently of current credits; the card never enables a Claude Code reset.

## Authorization and rollout

`SubscriptionControls` defaults to staff-organization rollout. It gates the new
single-account read, the card's account loading, and issuance of
`subscription:read` / `subscription:switch` run capabilities. The existing list
and activate routes require the respective capability for agent credentials
and recheck the switch on each request. Existing human settings reads and
activation are unchanged when the switch is disabled.

Reset endpoints do not accept agent-run credentials; no reset capability is
issued. The user-confirmed Platform control uses the user's own authenticated
session and the existing account ownership checks. The link never includes
credentials, emails, quotas, or reset credits. Opening it in another workspace
shows unavailable rather than switching workspace or granting access.

See [deployment compatibility](deployment-compatibility.md) for mixed-version
behavior and [chat cards](chat-cards.md) for the shared rendering contract.
