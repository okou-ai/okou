# Agent-controlled mail notifications

Stage one of [#38080](https://github.com/okou-ai/okou/issues/38080) adds an
agent-facing notification tool. Morning Brief remains on its existing Official
Automation completion email. Its `daily-delivery` blueprint, `resultEmail: true`,
instructions, model selection, and billing policy do not change in this stage.

## CLI and API

```bash
okou notify mail --to me --subject "Your brief" \
  --file brief.md --idempotency-key morning-brief:2026-10-08 --json
okou notify get <notification-id> --json
```

`--to me` is the default and the only recipient. The API derives the recipient
from the run token's user and Clerk's account email, and the source link from
the token's run ID and configured `APP_URL`. Agents cannot supply sender,
recipients, CC/BCC, unsubscribe headers, or the source URL. No Gmail or Outlook
connector is required. This is an Okou notification, rather than a message sent
from the user's mailbox.

Supply the subject and a stable `--idempotency-key`. Supply the Markdown body
using `--text`, `--file`, or piped stdin; `--text` and `--file` are mutually
exclusive and each takes precedence over stdin. Subject/body limits are 180/8000
Unicode characters. Subject line breaks and blank content are rejected. Keys
contain 1–200 ASCII letters, digits, or `._:/-`.

`POST /api/notifications/mail` accepts only an Okou agent token carrying
`notify:write`. New notifications require an owned, running run and current
workspace membership. `notifyMail` is disabled by default, gates capability
issuance and the live route, and is a rollout switch, not an authorization
boundary. Enabling it requires a new run for capability issuance. Human
session/PAT credentials may use `GET /api/notifications/:id` to read their own
workspace-scoped receipts; they cannot send through this endpoint.

The response envelope includes `notificationId`, `channel: "mail"`,
`recipient: "me"`, `status`, nullable `reason`, and `deduplicated`.

| Status    | Meaning                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `queued`  | Accepted into the existing email outbox, including provider retries.                                                                 |
| `sent`    | The provider accepted the email; inbox delivery is not confirmed.                                                                    |
| `skipped` | No new provider request: `unsubscribed`, `suppressed`, or `no-email`.                                                                |
| `failed`  | Delivery expired or exhausted retries (`expired` / `delivery-failed`). An earlier timed-out provider request may have been accepted. |

Skipped/failed receipts are successful API reads, not transport errors. CLI
`--json` prints receipts to stdout and action errors to stderr as structured
JSON, with exit code 1 for rejected actions. Standard Commander argument errors
use its normal error output. Querying a failed receipt exits successfully because
the query succeeded.

## Idempotency and delivery ownership

The durable `mail_notifications` table has a unique `(org_id, user_id,
idempotency_key)` claim. It stores a hash of the exact recipient selector,
subject, and body, plus delivery metadata; body content stays in the existing
outbox. Same key and content returns the original ID and current status, even
across runs or outbox cleanup. Same key with different content returns `409`.
After a timeout, retry the same key and content or query the returned ID. A new
key explicitly requests a new notification. A skipped or failed claim is never
silently requeued; intentional resending needs a new key.

Enqueue atomically commits the receipt and outbox intent and serializes with run
termination and preference writes. The existing outbox drain/cron retains its
provider idempotency key, committed provider payload, lease, pacing, TTL, and
retry policy. No second delivery worker is introduced. It renders the new
`agent-notification` template with safe Markdown, an Okou sender, HTML/text
parts, the run link, and both visible and one-click unsubscribe controls.
Opt-out and suppression are rechecked before an attempt. An already in-flight
provider request cannot be recalled. Final outbox and receipt state commit
together; cleanup marks remaining queued receipts expired in the transaction
that deletes their outbox rows. A provider/network ambiguity is reported as a failed attempt rather
than a guarantee that no mail exists.

User, organization, and membership deletion remove the scoped receipts and
associated outbox content after revoking run authority. Ordinary run deletion
does not remove receipt identity. Removing an owner does not recall mail already
accepted by the provider.

## Rollout and acceptance

Apply the additive migration, deploy API and every outbox drain worker with the
new template reader, then release the CLI. Keep `notifyMail` disabled until all
old drain instances are gone; old workers cannot read the new template. See
[deployment compatibility](deployment-compatibility.md#agent-mail-notifications-stage-one).

Before stage two, enable only the acceptance cohort, start a real authorized
run, invoke the command, query its receipt, and confirm the resulting email in
the intended user's mailbox. Repeat the same key/content and confirm one email;
verify conflict, opt-out, and suppression behavior. Unit/integration checks cover
CLI input/output, public API admission/idempotency/ownership, and safe rendering;
they do not prove production provider configuration or inbox delivery.

Stage two separately changes the Official revision's `resultEmail` to `false`
and adds agent notification instructions, including when to skip an empty brief
and how to derive one stable key per daily occurrence. Morning Brief migration
and schedule admission currently require result email and must be updated in that
stage. Drain already-accepted runs under their existing callback snapshots before
retiring the completion-email mechanism.
