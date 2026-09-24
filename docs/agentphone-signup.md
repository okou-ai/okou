# AgentPhone Signup

The built-in `signup` command registers a phone-only account when necessary,
prepares a workspace and default agent, connects AgentPhone, and delivers the
welcome conversation. `signup` and `/signup` are complete-message commands;
matching ignores case and surrounding whitespace.

`FeatureSwitchKey.AgentPhoneSignup` (`agentPhoneSignup`) is globally disabled
by default. Ingress may have no user or organization identity, so this feature
uses the global switch rather than a staff organization allowlist. This change
does not enable the switch or change production Clerk or AgentPhone settings.

## Supported ingress and identity

Automatic registration accepts a signed, direct iMessage event with an E.164
phone sender, addressed to the configured `AGENTPHONE_AGENT_ID`. Group messages
do not register accounts. SMS, MMS, and Apple ID email senders use the existing
browser-based connection flow.

An existing AgentPhone connection keeps its recorded account and workspace.
For an unconnected sender, Clerk must return one exact phone match, and that
phone must be verified before the existing account can be connected. Banned or
locked accounts are unavailable. A phone-only command does not merge a separate
email account that has no matching phone identifier.

| Current state                            | Result                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Clerk account                         | Create the phone user, create its workspace, initialize the default agent and limited-free bootstrap, complete onboarding, connect, and deliver welcome. |
| Existing account with no workspace       | Create and initialize its signup workspace, then connect and deliver welcome.                                                                            |
| Existing account with one workspace      | Use its current membership and connect to that workspace.                                                                                                |
| Existing account with several workspaces | Use a verified, saved signup-workspace preference when available; otherwise send the connection link so the user chooses.                                |
| Already connected                        | Keep the connection, validate the current account and membership, and deliver welcome again.                                                             |
| Incomplete prior attempt                 | Reconcile existing provider resources and resume the remaining local steps.                                                                              |

Existing membership roles remain authoritative. Members are never promoted to
admin by signup. Workspace bootstrap runs only with a current admin membership;
members need the existing workspace's default agent to be ready. An unavailable
default agent produces a message asking the user to contact a workspace admin.

The Web welcome thread uses the existing identity-derived thread ID. Repeated
commands reuse that conversation and send another four-part phone welcome,
including the contact card. The connection uses the welcome thread for an unused
default-agent session so later phone messages continue there. Existing active
session routes remain in place.

## Clerk and AgentPhone activation requirements

These requirements come from the installed `@clerk/backend` 3.13.1 SDK and
Clerk's documented API behavior. They are **not evidence that the production
instance already satisfies them**. Verify the actual instance and provider
configuration before enabling the global switch.

- Enable phone identifiers. Clerk rejects fields that the instance does not
  allow, and `createUser` still requires every field configured as mandatory.
  Email, username, names, and any other required fields must permit a phone-only
  account; do not invent their values to bypass the instance configuration.
- The request uses `skipPasswordRequirement: true`. Clerk does not permit this
  when a password is the only available sign-in method. Enable a usable
  passwordless sign-in path for these users.
- Verify phone sign-in and the allowed SMS countries for later Web or Desktop
  login. Clerk documents a default SMS allowlist of the US and Canada; disabled
  countries cannot receive OTPs and may not be accepted for signup. Confirm the
  actual intended countries, rather than assuming that receiving an iMessage
  also makes Clerk SMS login available.
- Enable organizations and organization slugs. The workspace uses a
  deterministic slug derived from the Clerk user ID, which lets independent
  jobs find the same organization after an interrupted create. Clerk reports
  disabled slugs as `403 organization_slugs_disabled`.
- Ensure instance organization quotas and per-user creation limits permit the
  new workspace. `createdBy` makes the user a member with Clerk's configured
  creator role; current membership is read back before local initialization.
- Confirm the configured AgentPhone webhook verification and iMessage sender
  guarantees. The backend Clerk API marks newly supplied phone numbers verified
  automatically. This implementation relies on AgentPhone's authenticated
  direct iMessage sender identity as the proof of number control; a webhook
  signature alone proves the provider origin, not every possible channel's
  sender assurance.

Required-field, feature, quota, authorization, and other configuration errors
remain failures. Only explicit uniqueness errors or narrowly identified
transport/server failures permit an exact reconciliation read after a create.
The application does not blindly retry the provider write.

Provider references:

- [Clerk createUser](https://clerk.com/docs/reference/backend/user/create-user)
- [Clerk createOrganization](https://clerk.com/docs/reference/backend/organization/create-organization)
- [Clerk sign-up and sign-in options](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options)
- [Clerk backend errors](https://clerk.com/docs/guides/development/errors/backend-api)

## Durable work and delivery limits

Each inbound provider message ID identifies one durable `agentphone-signup`
background job. Repeated webhook delivery reaches that receipt even if the
ordinary inbound message already exists. The webhook starts work promptly; the
existing background-job cron can resume it after a failed request or process
interruption. Jobs use leases and bounded retries, with at most five
worker attempts.

Checkpoints preserve resolved account ownership, initialization, connection,
welcome thread, and delivery progress. Clerk phone uniqueness and the owned,
deterministic organization slug reconcile provider resources. The existing
workspace bootstrap and welcome-thread creation remain idempotent. A new user
message containing `signup` creates a new delivery request without requiring a
new account or workspace.

AgentPhone message sends have no documented idempotency key. The worker records
`sending` before each part, checkpoints the acknowledged part count after success,
and marks `sent` after the final part. A definite rejection of a later part resumes
from that part without repeating earlier messages. An explicit provider rejection
permits bounded retry. A timeout, transport error, or server error may mean the
text was already delivered, so a resumed job with
an uncertain send is failed instead of sending a possible duplicate. A user can
send a new `signup` command to request welcome again. This is not an exactly-once
delivery guarantee, and an unknown send must not be reported as confirmed
delivery.

Receipts expire after 48 hours in bounded cleanup batches, including while the
switch is disabled. Already stored inbound messages do not recreate an expired
receipt on webhook replay. Once the user identity is known, the job joins normal
account-erasure ownership before workspace creation. If that initial admission
finds the account already erased, the anonymous job is terminalized atomically
instead of retrying identity creation. A separate terminal receipt retains only
a derived message-ID UUID and empty data, without account IDs or
phone numbers. That anti-replay marker survives erasure so an old webhook cannot
re-create the deleted account. A new message ID is a new signup request.

Disabling the switch pauses admission and worker execution. Keep pending jobs
and their supported handler version available within that retention period when
planning a rollback. Re-enable only after the prerequisites still hold; a merge
alone does not prove provider readiness or successful end-to-end delivery.

## API and Desktop compatibility

`GET /api/auth/me` preserves the existing response for users with an email.
For a phone-only account, it returns `email: null` and the verified primary
`phoneNumber`. It does not substitute a secondary identifier or write a fake
email into the email-only `user_cache` table. Phone-only profiles are read from
Clerk without using that cache; no database migration is required.

The updated Desktop accepts nullable email and displays the phone number when
email is absent. Its account and workspace authority still come from the same
authenticated API response and existing membership checks.

| Pair                                                   | Compatibility                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Updated Desktop with the preceding API                 | Existing email responses remain valid; `phoneNumber` is optional.       |
| Updated API with preceding Desktop, email account      | The unchanged email response remains valid.                             |
| Updated API with preceding Desktop, phone-only account | Unsupported: the older Desktop response parser requires a string email. |
| Updated API with updated Desktop, phone-only account   | Supported by the nullable email and optional phone contract.            |

Ship the compatible Desktop and establish its rollout or upgrade requirement
before enabling phone-only registration. Do not activate this feature during a
mixed API fleet that cannot consistently resume signup jobs. A rollback below
the phone-only API implementation also removes `auth/me` support for accounts
already created without email, even after the signup switch is disabled.

Email-dependent features need their own explicit outcome for a phone-only user.
The current data-export completion notification still requires a primary email;
this change does not add phone delivery for those notifications. Track that
limitation when evaluating activation readiness.
