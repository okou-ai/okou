# webhooks-callbacks.bdd

## webhooks-callbacks.bdd-001

- Vitest: "WHCB-01: third-party webhook verification boundaries > reports unconfigured third-party webhooks through public responses"
- Mode: run
- Given: The Stripe webhook secret and the GitHub App webhook secret are not configured.
- When: A caller posts `{}` to `POST /api/webhooks/stripe` with a `stripe-signature` header, and a correctly signed GitHub `ping` to `POST /api/webhooks/github`.
- Then: Stripe returns HTTP 503 with `{ error: "Stripe billing is not configured" }`. GitHub returns HTTP 503 with `{ error: "GitHub App integration is not configured" }`.

## webhooks-callbacks.bdd-002

- Vitest: "WHCB-01: third-party webhook verification boundaries > rejects Stripe requests with missing or invalid signatures"
- Mode: run
- Given: The Stripe webhook secret is configured.
- When: A caller posts to `POST /api/webhooks/stripe` without a `stripe-signature` header, then with a signature Stripe rejects, then with a valid signature for a `charge.succeeded` event.
- Then: The missing header returns HTTP 401 `{ error: "Missing stripe-signature header" }`. The rejected signature returns HTTP 401 `{ error: "Invalid webhook signature" }`. The signed `charge.succeeded` event returns HTTP 200 `OK`.

## webhooks-callbacks.bdd-003

- Vitest: "WHCB-01: third-party webhook verification boundaries > accepts signed Stripe events that do not require existing billing state"
- Mode: run
- Given: The Stripe webhook secret is configured and no billing state exists for the referenced objects.
- When: Stripe sends validly signed events to `POST /api/webhooks/stripe`: a credit-purchase `checkout.session.completed` without customer or subscription, an unpaid one-time `checkout.session.async_payment_succeeded`, an `invoice.paid` with no lines or subscription, a `customer.subscription.deleted` without org metadata, and `subscription_schedule.released` and `subscription_schedule.canceled` for unknown schedules.
- Then: Every event returns HTTP 200 `OK`.

## webhooks-callbacks.bdd-004

- Vitest: "WHCB-01: third-party webhook verification boundaries > rejects Clerk requests when webhook verification is missing or invalid"
- Mode: run
- Given: The Clerk webhook secret is configured and Svix verification fails.
- When: A caller posts `{}` to `POST /api/webhooks/clerk` once with no Svix headers and once with an invalid `svix-signature`.
- Then: Both requests return HTTP 401 with `{ error: "Invalid webhook signature" }`.

## webhooks-callbacks.bdd-005

- Vitest: "WHCB-01: third-party webhook verification boundaries > accepts verified Clerk events that do not require visible cleanup"
- Mode: run
- Given: The Clerk webhook secret is configured and Clerk verifies a `session.created` event.
- When: Clerk posts the event to `POST /api/webhooks/clerk`.
- Then: The response is HTTP 200 `OK`.

## webhooks-callbacks.bdd-006

- Vitest: "WHCB-01: third-party webhook verification boundaries > bootstraps limited-free billing and model providers after Clerk org creation"
- Mode: run
- Given: The Clerk webhook secret is configured and Clerk verifies an `organization.created` event for a new organization created by an admin.
- When: Clerk posts the event to `POST /api/webhooks/clerk`; the admin then reads billing status, voice quota, personal usage-pack credits, and the run model list.
- Then: The webhook returns HTTP 200 `OK`. Billing shows 0 credits, no grants, tier `limited-free-1`, no pending onboarding payment, the limited-free capabilities (active, no concurrency purchase or auto-recharge, restricted built-in models, no workflow webhook automation, concurrency limit 2), and no subscription. Voice quota allows 0 of 10. Personal credits total 1000 bonus credits (0 purchased) in one bonus grant expiring about 30 days from now. The only run model is `auto`.

## webhooks-callbacks.bdd-007

- Vitest: "WHCB-01: third-party webhook verification boundaries > keeps Clerk membership creation from duplicating bootstrap state"
- Mode: run
- Given: An organization was bootstrapped by a verified Clerk `organization.created` webhook, and its admin has 1000 personal credits in one grant.
- When: Clerk posts a verified `organizationMembership.created` event for the same admin to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200 `OK`. Billing still shows 0 credits, no grants, tier `limited-free-1`, and no pending payment; personal credits are unchanged. Onboarding status shows `needsOnboarding: true`, `onboardingComplete: false`, `isAdmin: true`, `hasOrg: true`.

## webhooks-callbacks.bdd-008

- Vitest: "WHCB-01: third-party webhook verification boundaries > rejects GitHub requests with missing headers or invalid signatures"
- Mode: run
- Given: The GitHub App webhook secret is configured.
- When: A caller posts to `POST /api/webhooks/github` with no GitHub headers, then with an invalid `x-hub-signature-256`, then a correctly signed `ping`, then a correctly signed `fork` event.
- Then: Missing headers return HTTP 401 `{ error: "Missing GitHub webhook headers" }`. The bad signature returns HTTP 401 `{ error: "Invalid signature" }`. The ping returns HTTP 200 `{ message: "pong" }` and the fork event returns HTTP 200 `OK`.

## webhooks-callbacks.bdd-009

- Vitest: "WHCB-01: third-party webhook verification boundaries > accepts signed GitHub events that do not dispatch work"
- Mode: run
- Given: The GitHub App webhook secret is configured and no installation is linked to any workspace.
- When: GitHub sends correctly signed events to `POST /api/webhooks/github`: a `pull_request` synchronize, an edited `issue_comment` mentioning the bot, a bot-authored mention comment, an unmentioned comment, a mention comment for an unlinked installation, and `installation` suspend, created and deleted events.
- Then: Every event returns HTTP 200 `OK`.

## webhooks-callbacks.bdd-010

- Vitest: "WHCB-02: built-in generation callback boundaries > rejects invalid provider tokens before reading generation state"
- Mode: run
- Given: No built-in generation job exists for a random generation ID.
- When: A caller posts `{}` to `POST /api/webhooks/built-in-generations/fal/:generationId` with query token `invalid-token`.
- Then: The response is HTTP 401 with `{ error: "Invalid token" }`.

## webhooks-callbacks.bdd-011

- Vitest: "WHCB-02: built-in generation callback boundaries > accepts valid provider callbacks that do not have an active generation job"
- Mode: run
- Given: A valid fal callback token is issued for a random generation ID and visual key `visual-bdd`, but no active generation job exists.
- When: fal posts a `COMPLETED` callback with an empty image list to `POST /api/webhooks/built-in-generations/fal/:generationId` with that token and visual key.
- Then: The response is HTTP 200 `OK`.

## webhooks-callbacks.bdd-012

- Vitest: "WHCB-03: email inbound webhook boundaries > keeps missing, invalid, and signed non-run Resend events visible through the inbound API"
- Mode: run
- Given: Initially no Resend signature headers are sent; then the Resend webhook secret is configured. No recipient matches a Clerk user, and the Resend API key is later unset.
- When: Resend posts to `POST /api/email/inbound`: an unsigned `email.received`; an `email.opened` with an invalid Svix signature; a signed `email.opened`; a signed `email.bounced`; a signed `email.complained`; a signed `email.received` to an unrecognized organization alias; and a signed `email.received` to a reply address with an invalid token.
- Then: The unsigned request returns HTTP 401 `{ error: "Missing signature headers" }` and the bad signature returns HTTP 401 `{ error: "Invalid signature" }`. Every signed event returns HTTP 200 `{ received: true }`.

## webhooks-callbacks.bdd-013

- Vitest: "WHCB-04: internal callback and event-consumer boundaries > exports raw events for a debug-enabled owner while the trace stays best effort"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox and enables the Okou debug feature switch. The Axiom run-events dataset first accepts events, then the sessions token is unset, then it is restored while Axiom returns HTTP 503.
- When: The sandbox calls `POST /api/webhooks/run/events` three times with an assistant event (sequence 1) and a tool result (sequence 2), once under each Axiom condition.
- Then: Every call returns HTTP 200 with `{ received: 2, firstSequence: 1, lastSequence: 2 }`. The first call sends one Axiom ingest request whose rows carry the Run ID, user ID, sequence number, event type and raw event data. The unconfigured call sends no further ingest request. The unavailable call results in two ingest attempts.

## webhooks-callbacks.bdd-014

- Vitest: "WHCB-04: internal callback and event-consumer boundaries > acknowledges the event batch while optional Axiom ingestion is pending"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox with the Okou debug feature switch enabled. The Axiom run-events ingest request stalls until it is released.
- When: The sandbox calls `POST /api/webhooks/run/events` with one `result` event (sequence 0).
- Then: The webhook returns HTTP 200 with `{ received: 1, firstSequence: 0, lastSequence: 0 }` while the Axiom ingest request is still pending; the ingest then completes in the background.

## webhooks-callbacks.bdd-015

- Vitest: "WHCB-05: sandbox agent webhook boundaries > returns 500 without API error capture when telemetry transport fails"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured, and the connection to the sandbox network telemetry dataset fails with a transport error.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with one network log entry.
- Then: The response is HTTP 500.

## webhooks-callbacks.bdd-016

- Vitest: "WHCB-05: sandbox agent webhook boundaries > captures a deterministic telemetry failure alongside a transport failure"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured. The sandbox metrics dataset fails with a transport error and the network dataset returns HTTP 503.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with one metric sample and one network log entry.
- Then: The response is HTTP 500, and exactly one error is reported to Sentry: a `DirectAxiomIngestError` with reason `http_status` and status 503.

## webhooks-callbacks.bdd-017

- Vitest: "WHCB-05: sandbox agent webhook boundaries > preserves parent cancellation at the telemetry request boundary"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The sandbox network telemetry ingest stalls until released.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with one network log entry; while ingest is in flight the caller's request is aborted, and ingest is then released.
- Then: The response is HTTP 500.

## webhooks-callbacks.bdd-018

- Vitest: "WHCB-05: sandbox agent webhook boundaries > ingests collector OOM evidence and fallback with the same identity and rejects cross-run or forged payloads"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and the sandbox metrics dataset accepts every event.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with collector OOM evidence from a `sample` snapshot, then with the `cleanup` fallback carrying the same incidents, then with the evidence under a different Run ID, then four altered payloads (an extra `prompt` field, five duplicate incidents, a changed `operation_id`, and kernel events re-labelled with source `host`).
- Then: The sample returns HTTP 200 with `success: true` and `oomEvidenceVersion: 1`, and the fallback returns HTTP 200 with `oomEvidenceVersion: 1`. The cross-run report returns HTTP 401 and each altered payload returns HTTP 400. Axiom receives exactly two ingest requests.

## webhooks-callbacks.bdd-019

- Vitest: "WHCB-05: sandbox agent webhook boundaries > acknowledges owned managed-task OOM evidence and rejects invalid task paths"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and the sandbox metrics dataset accepts every event.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with collector OOM evidence for managed tasks, then eight altered payloads that set a nested kernel event's `task_cgroup` or `oom_cgroup` to an invalid task path (a non-task tools path, a non-UUID task ID, a `..` traversal, or a different exec ID).
- Then: The valid evidence returns HTTP 200 with `success: true` and `oomEvidenceVersion: 1`. Every altered payload returns HTTP 400. Axiom receives exactly one ingest request.

## webhooks-callbacks.bdd-020

- Vitest: "WHCB-05: sandbox agent webhook boundaries > does not acknowledge OOM evidence when the Axiom destination is unavailable"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is not configured.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with collector OOM evidence from a `cleanup` snapshot.
- Then: The response is HTTP 200 with exactly `{ success: true, id: <runId> }`, with no `oomEvidenceVersion` acknowledgement.

## webhooks-callbacks.bdd-021

- Vitest: "WHCB-05: sandbox agent webhook boundaries > does not acknowledge collector OOM evidence after failed ingestion"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and the sandbox metrics dataset returns HTTP 500 (failed ingestion).
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with collector OOM evidence from a `sample` snapshot.
- Then: The response is HTTP 500 and its body has no `oomEvidenceVersion`.

## webhooks-callbacks.bdd-022

- Vitest: "WHCB-05: sandbox agent webhook boundaries > does not acknowledge collector OOM evidence after partial ingestion"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and the sandbox metrics dataset reports a partial ingest (`ingested: 1`, `failed: 1`).
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with collector OOM evidence from a `sample` snapshot.
- Then: The response is HTTP 500 and its body has no `oomEvidenceVersion`.

## webhooks-callbacks.bdd-023

- Vitest: "WHCB-05: sandbox agent webhook boundaries > ingests collector memory in ordinary mixed telemetry and degrades an unusable snapshot without dropping the batch"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and every Axiom dataset accepts its events.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with a system log, two metric samples carrying collector memory snapshots, a network log and a sandbox operation; it then repeats the batch with the first memory snapshot made unusable (relative cgroup paths).
- Then: Both calls return HTTP 200 with exactly `{ success: true, id: <runId> }`, and each call ingests into the `sandbox-telemetry-metrics`, `sandbox-telemetry-network` and `sandbox-telemetry-system` datasets.

## webhooks-callbacks.bdd-024

- Vitest: "WHCB-05: sandbox agent webhook boundaries > accepts Runner home startup telemetry while preserving run ownership"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with Runner home startup telemetry for each startup path (`home`, `workspace`, `sandbox`, `blank`, `cold`); then with a different Run ID, with sandbox operations naming a different `run_id`, with operations but no Run ID, and with no credentials.
- Then: Each startup-path report returns HTTP 200 with exactly `{ success: true, id: <runId> }`. The four ownership violations each return HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-callbacks.bdd-025

- Vitest: "WHCB-05: sandbox agent webhook boundaries > keeps dedicated OOM evidence strict so an unusable payload is never acknowledged"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox. The telemetry Axiom token is configured and Axiom would accept any ingest.
- When: The sandbox calls `POST /api/webhooks/run/telemetry` with a system log and dedicated OOM evidence whose cgroup paths are relative (unusable).
- Then: The response is HTTP 400 and Axiom receives no ingest requests.

## webhooks-callbacks.bdd-026

- Vitest: "WHCB-05: sandbox agent webhook boundaries > rejects unauthenticated and mismatched sandbox reports"
- Mode: run
- Given: Two members each have a chat Run executing on a sandbox; the second Run's sandbox credential is used against the first Run.
- When: A caller sends `POST /api/webhooks/run/heartbeat` for the first Run with no credentials and with a non-sandbox bearer token; the second sandbox sends `POST /api/webhooks/run/telemetry` and `POST /api/webhooks/run/usage-event` for the first Run.
- Then: All four requests return HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-callbacks.bdd-027

- Vitest: "accepts a sandbox callback lifecycle through the run webhooks"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox.
- When: The sandbox calls `POST /api/webhooks/run/heartbeat`, then `POST /api/webhooks/run/events` with one `system` event (sequence 1), then `POST /api/webhooks/run/complete` with exit code 1, error `Sandbox exited`, and last event sequence 1.
- Then: The heartbeat returns HTTP 200 with `ok: true`. The events call returns HTTP 200 with `{ received: 1, firstSequence: 1, lastSequence: 1 }`. The completion returns HTTP 200 with `{ success: true, status: "failed" }`.

## webhooks-callbacks.bdd-028

- Vitest: "WHCB-06: sandbox agent artifact webhook boundaries > rejects mismatched sandbox artifact reports"
- Mode: run
- Given: Two members each have a chat Run executing on a sandbox; the second Run's sandbox credential is used against the first Run.
- When: The second sandbox reports for the first Run via `POST /api/webhooks/run/events`, `POST /api/webhooks/run/complete` (exit 0), `POST /api/webhooks/run/complete` with Claude Code session outputs, `POST /api/webhooks/run/storages/prepare`, and `POST /api/webhooks/run/storages/commit`.
- Then: Every request returns HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-callbacks.bdd-029

- Vitest: "WHCB-09: sandbox storage writes and native history blobs land in the run organization > prepares, commits, dedups, and bounds sandbox storage writes for the run org"
- Mode: run
- Given: A signed-in member has a chat Run executing on a sandbox whose execution input includes a canonical writeback Storage mount. The object store accepts the uploaded archive and manifest.
- When: The sandbox calls `POST /api/webhooks/run/storages/prepare` for an unmounted storage ID, then prepares and commits a 2048-byte `index.html` to the writeback storage via `POST /api/webhooks/run/storages/prepare` and `POST /api/webhooks/run/storages/commit`, re-prepares identical content, commits with a mismatched version ID, and prepares files exceeding the size limit. The member then cancels the Run, the sandbox reports completion, and the member starts a new chat Run.
- Then: The unmounted prepare returns HTTP 404 `Writeback storage not found`. The prepare returns HTTP 200 with upload keys under the Run organization's prefix and HTTPS presigned archive and manifest URLs; the commit returns HTTP 200 with the version ID, storage name, size 2048 and file count 1. The duplicate prepare returns `{ versionId, existing: true }`. The mismatched commit returns HTTP 400 `Version ID mismatch - files may have changed`, and the oversized prepare returns HTTP 413 `PAYLOAD_TOO_LARGE`. The Run reads `cancelled` and the new Run's storage mount carries the committed version with an archive URL.

## webhooks-callbacks.bdd-030

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > rejects prepare when its owner cancels the run during upload URL signing"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. Signing the upload URL stalls until released.
- When: The sandbox calls `POST /api/webhooks/run/storages/prepare` for the writeback storage; while signing is in flight, the member cancels the Run via the public cancel endpoint, and signing is then released.
- Then: The cancel returns HTTP 200, the prepare returns HTTP 404 with message `Active agent run not found`, and the Run reads back as `cancelled`.

## webhooks-callbacks.bdd-031

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > rejects prepare before issuing upload URLs after completed"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The sandbox completes the Run with exit code 0 and Claude Code session outputs, so it reads back as `completed`.
- When: The sandbox calls `POST /api/webhooks/run/storages/prepare` for the writeback storage with a one-byte file.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no additional upload URLs are signed.

## webhooks-callbacks.bdd-032

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > rejects prepare before issuing upload URLs after failed"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The sandbox reports the Run as failed (`Storage writer failed`), so it reads back as `failed`.
- When: The sandbox calls `POST /api/webhooks/run/storages/prepare` for the writeback storage with a one-byte file.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no additional upload URLs are signed.

## webhooks-callbacks.bdd-033

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > rejects prepare before issuing upload URLs after cancelled"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The member cancels the chat Run, so it reads back as `cancelled`.
- When: The sandbox calls `POST /api/webhooks/run/storages/prepare` for the writeback storage with a one-byte file.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and no additional upload URLs are signed.

## webhooks-callbacks.bdd-034

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > rejects prepare-then-cancel commit without object writes or moving the current mount"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The sandbox has prepared a 2048-byte file version against the current mount version, and the member then cancels the Run.
- When: The sandbox calls `POST /api/webhooks/run/storages/commit` for the prepared version.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, no object store calls are made, and a follow-up Run in the same thread still mounts the original parent version.

## webhooks-callbacks.bdd-035

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > acknowledges a proven committed retry after cancellation without writes"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The sandbox has prepared and committed a 4096-byte file version, and the member then cancels the Run.
- When: The sandbox retries the exact same `POST /api/webhooks/run/storages/commit` request.
- Then: The response is HTTP 200 with `success: true`, the same version ID, size 4096, file count 1 and `deduplicated: true`. No object store calls are made, and a follow-up Run in the same thread mounts the committed version.

## webhooks-callbacks.bdd-036

- Vitest: "WHCB-10: terminal Runs close sandbox storage write authority > keeps a deduplicated head move observable after cancellation"
- Mode: run
- Given: A signed-in member has a chat Run (model `claude-fable-5-1`) executing on a sandbox whose execution input includes a canonical writeback Storage mount. The sandbox has committed a `restored` version, then a `replacement` version on top of it.
- When: The sandbox commits the `restored` version again with the replacement as parent via `POST /api/webhooks/run/storages/commit`; the member then cancels the Run and the sandbox retries the same commit.
- Then: The head-move commit returns HTTP 200 with the restored version ID, size 1024, file count 1 and `deduplicated: true`. The retry after cancellation returns HTTP 200 with `deduplicated` truthy, and a follow-up Run in the same thread mounts the restored version.

## webhooks-callbacks.bdd-037

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > uses each successful card payment as the customer default"
- Mode: run
- Given: Stripe billing is configured. Stripe reports the first payment method as a `card` and the second as a `us_bank_account`, both owned by the same customer.
- When: Stripe sends two signed `payment_intent.succeeded` webhooks to `POST /api/webhooks/stripe`, one paid with the card and one with the bank account.
- Then: Both webhooks return HTTP 200. After the card payment, the Stripe customer is updated with the card as `invoice_settings.default_payment_method`; after the bank payment, the customer is not updated.

## webhooks-callbacks.bdd-038

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > keeps the normal credit window for a non-Atom early cancellation"
- Mode: run
- Given: A member's workspace is granted a Pro entitlement through Stripe with a period ending in 30 days and a non-Atom `cancel_at` 7 days from now.
- When: The member reads billing status.
- Then: The tier is `pro`, `currentPeriodEnd` equals the cancel-at time, and there is one `subscription_renewal` grant of 20,000 credits expiring one month after the original period end.

## webhooks-callbacks.bdd-039

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > replays and expires subscription invoice credits"
- Mode: run
- Given: A member's workspace holds a Pro entitlement through Stripe with 20,000 credits in one grant.
- When: Stripe sends signed `invoice.paid` webhooks to `POST /api/webhooks/stripe`: a redelivery of the entitlement invoice; a new invoice whose period ended 60 days ago; a renewal invoice; two concurrent deliveries of one new invoice; a redelivery of the stale invoice; and an invoice with no plan line.
- Then: Every webhook returns HTTP 200. The redelivery leaves 20,000 credits in one grant. The stale invoice keeps 20,000 credits and one grant but moves `currentPeriodEnd` to the stale period end. The renewal raises credits to 40,000 with two grants. The concurrent duplicates grant once, reaching 60,000 with three grants. The stale redelivery and the plan-less invoice leave 60,000 credits.

## webhooks-callbacks.bdd-040

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > atomically accumulates distinct auto-recharge invoices"
- Mode: run
- Given: A member's workspace holds a Pro entitlement through Stripe with 20,000 credits.
- When: Stripe concurrently sends signed `invoice.paid` webhooks to `POST /api/webhooks/stripe`: auto-recharge invoice A (5000 credits) twice and a distinct auto-recharge invoice B (5000 credits) once.
- Then: Billing shows 30,000 credits with exactly two `auto_recharge` grants, each 5000 credits with 5000 remaining and an expiry in year 2999 or later.

## webhooks-callbacks.bdd-041

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > grants, refreshes, and clamps trial credits from trial-period invoices"
- Mode: run
- Given: Stripe billing is configured and a member completed onboarding without credits. The Stripe customer carries the member's org ID in metadata, and the subscription is `trialing`.
- When: Stripe sends signed webhooks to `POST /api/webhooks/stripe`: a trial `invoice.paid` (trial end +7 days, period end +30 days); a second trial invoice (trial end +14, period end +60); a `customer.subscription.updated` shortening the trial to +10 days; two overlapping redeliveries of that update (retrying any HTTP 500); a trialing `checkout.session.completed`; and, after the clock passes the trial end, a trial-extension `invoice.paid` delivered twice.
- Then: The first invoice binds the customer: tier `pro`, 20,000 credits, status `trialing`, period end +30 and next credit expiry at the trial end. The second keeps 20,000 credits in one grant, with period end +60 and expiry at the new trial end. The shortening clamps period end and expiry to +10 days. At least one redelivery returns HTTP 200 and the state converges to 20,000 credits in one grant, `trialing`, clamped dates. The checkout keeps 20,000 credits. After expiry, the extension invoice leaves 0 credits, no grants and `trialing`, and its redelivery still leaves 0 credits.

## webhooks-callbacks.bdd-042

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > upgrades to team, picks queued chat threads, and cancels the replaced pro subscription"
- Mode: run
- Given: A Pro member's workspace has three running thread Runs and a chat input queued at the Pro concurrency limit (3 active). Stripe reports a new active Team subscription for the same customer and lists both subscriptions.
- When: Stripe sends to `POST /api/webhooks/stripe`: two concurrent deliveries of the Team `invoice.paid`; a redelivery; a lower-tier subscription `invoice.paid`; a `billing_downgrade` setup `checkout.session.completed` targeting Pro; and `customer.subscription.deleted` for the Team subscription. The member then cancels all four Runs.
- Then: The Pro subscription is cancelled in Stripe without invoicing or proration. Billing shows tier `team`, 140,000 credits including one 120,000 grant, Team capabilities (concurrency limit 10), active subscription with the Team period end, and unlimited voice quota. The queued thread starts a running Run and the queue shows tier `team` with 4 active. The redelivery cancels the Pro subscription again and keeps 140,000 credits; the lower-tier invoice changes nothing. The downgrade checkout creates a schedule from the Team subscription and updates it to a Team phase then a monthly Pro phase, both keeping the discount; billing shows a scheduled downgrade to Pro at the phase end. Deletion returns the workspace to `limited-free-1` with canceled status, no subscription, no scheduled change, limited-free capabilities and a 10-message voice limit. After cancelling the Runs, 0 are active.

## webhooks-callbacks.bdd-043

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > keeps a team upgrade when the replaced pro subscription is already absent"
- Mode: run
- Given: A Pro member's workspace has a Stripe subscription. Stripe reports a new active Team subscription for the same customer, lists no subscriptions, and rejects cancelling the old Pro subscription as `resource_missing`.
- When: Stripe sends a Team `invoice.paid` webhook to `POST /api/webhooks/stripe`, then a `customer.subscription.deleted` for the Team subscription.
- Then: The API attempts to cancel the old Pro subscription without invoicing or proration. Billing shows tier `team`, 140,000 credits, active status, a subscription, and no scheduled change. After the Team deletion, the tier is `limited-free-1` with no subscription.

## webhooks-callbacks.bdd-044

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > redelivers replacement cancellation after the paid grant commits without granting twice"
- Mode: run
- Given: A Pro member's workspace has a Stripe subscription. Stripe reports a new active Team subscription for the customer and lists the old Pro subscription; the first attempt to cancel the Pro subscription fails temporarily, later attempts succeed.
- When: Stripe sends a Team `invoice.paid` webhook to `POST /api/webhooks/stripe`, redelivers the same event twice, then sends `customer.subscription.deleted` for the replaced Pro subscription.
- Then: The first delivery returns HTTP 500, yet billing already shows tier `team`, 140,000 credits and one 120,000 grant. Both redeliveries return HTTP 200 and leave 140,000 credits with identical grants. After the Pro deletion, the workspace stays `team` with a subscription and 140,000 credits.

## webhooks-callbacks.bdd-045

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > keeps a newer purchase when the previous invoice is redelivered"
- Mode: run
- Given: A Pro member's workspace upgraded to Team through a Stripe `invoice.paid` (140,000 credits), after which the Team subscription was deleted. A `checkout.session.completed` then binds a newer active Pro subscription, and Stripe lists that newer subscription.
- When: Stripe redelivers the earlier Team `invoice.paid` to `POST /api/webhooks/stripe`, and any subscriptions the API cancels in Stripe are then reported back as `customer.subscription.deleted` webhooks.
- Then: After the redelivery and cancellation notifications, billing still shows an active subscription with the same tier, credits, and credit grants as before the redelivery.

## webhooks-callbacks.bdd-046

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > grants concurrency slots from Stripe subscription and picks queued chat threads until full"
- Mode: run
- Given: A Pro member's workspace has three running thread Runs and two chat inputs queued at the concurrency limit (limit 3, active 3).
- When: Stripe sends to `POST /api/webhooks/stripe`: `customer.subscription.created` for a concurrency add-on of quantity 2; its `invoice.paid`; a replay of that invoice; `customer.subscription.updated` to `past_due`; updates setting and clearing `cancel_at_period_end`; an update after which the subscription has no items; and `customer.subscription.deleted`.
- Then: After the invoice, billing lists the add-on with quantity 2, the period end and no pending cancellation; both queued threads start running Runs and the queue shows limit 5 with 5 active, while a further chat input stays queued. The replay keeps quantity 2 and limit 5. While `past_due`, the add-on stays listed and the limit stays 5. The cancel-at-period-end flag is reported true then false. Once the item is removed, no add-on is listed and the limit returns to 3. After deletion, no add-on is listed, the tier stays `pro` with a subscription, and the limit is 3.

## webhooks-callbacks.bdd-047

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > keeps Stripe quantity across prorations and stale events"
- Mode: run
- Given: A Pro member's workspace has a Stripe concurrency add-on subscription; Stripe's current subscription state is retrieved on each event.
- When: Stripe sends to `POST /api/webhooks/stripe`: the initial `invoice.paid` for quantity 10; `customer.subscription.updated` reducing quantity to 2; a proration `invoice.paid` crediting the original 10-seat line and charging a 2-seat line; a stale `customer.subscription.updated` carrying quantity 10 while Stripe's current state is 2; another update event carrying quantity 10; and a deletion.
- Then: After the initial invoice, billing lists the add-on with quantity 10. After the reduction and proration invoice, it lists quantity 2. Both quantity-10 update events leave the listed quantity at 2.

## webhooks-callbacks.bdd-048

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > reconciles stale concurrent Stripe deliveries after redelivery"
- Mode: run
- Given: A Pro member's workspace has a concurrency add-on paid at quantity 10. Stripe's current subscription state then changes to quantity 2.
- When: Stripe concurrently delivers a stale `customer.subscription.updated` (quantity 10) and a current one (quantity 2) to `POST /api/webhooks/stripe`, redelivering any that return HTTP 500, then redelivers the original paid invoice.
- Then: At least one concurrent delivery returns HTTP 200. After reconciliation, billing lists the add-on with quantity 2, credits are unchanged, and the run queue limit is 5. Replaying the paid invoice leaves the same add-on list, unchanged credits and limit 5.

## webhooks-callbacks.bdd-049

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > binds checkout and dashboard subscriptions to orgs without double-binding"
- Mode: run
- Given: Stripe billing is configured and a member completed onboarding without credits. The Stripe customer carries the member's org ID in metadata. A second organization has never been onboarded, and Clerk returns it.
- When: Stripe sends to `POST /api/webhooks/stripe`: a dashboard `customer.subscription.created` (active Pro); an `incomplete` dashboard subscription; a subscription `checkout.session.completed` and its redelivery; an `invoice.paid` for the checkout subscription; a same-tier checkout for another subscription; a dashboard subscription for an unknown customer; a dashboard subscription for another customer whose metadata names the same org; and an `invoice.paid` for the never-onboarded org's customer.
- Then: The dashboard subscription binds the workspace: active subscription, tier still `limited-free-1`, no period end. The incomplete subscription leaves it active and `limited-free-1`. Both checkout deliveries keep status `active`. The paid invoice grants tier `pro` with 20,000 credits. The same-tier checkout, the unknown customer and the rebinding attempt leave tier `pro`, status `active` and 20,000 credits. The late organization's billing shows tier `pro`, 20,000 credits and a subscription.

## webhooks-callbacks.bdd-050

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > grants purchased custom credit amounts"
- Mode: run
- Given: Stripe billing is configured and a member completed onboarding without credits.
- When: Stripe sends to `POST /api/webhooks/stripe`: an unpaid one-time-purchase `checkout.session.completed` for campaign `ZERO100`; its `checkout.session.async_payment_succeeded` (paid); a legacy paid credit-purchase checkout with `amount_total` 10,000 and an explicit expiry 45 days out; an invoice-backed credit-purchase checkout with `amount_subtotal` 10,000; and that invoice's `invoice.paid` with subtotal 10,000 and an expiry 90 days out.
- Then: The unpaid checkout grants nothing. The async payment adds 100,000 credits in a `one_time_purchase` grant. The legacy checkout adds a 100,000 `credit_purchase` grant expiring at the given 45-day time (baseline plus 200,000). The invoice-backed checkout alone grants nothing more; its `invoice.paid` adds a 100,000 `credit_purchase` grant expiring at the 90-day time (baseline plus 300,000).

## webhooks-callbacks.bdd-051

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > restores and schedules cancellations through setup checkouts and schedule webhooks"
- Mode: run
- Given: A member's workspace holds a Pro subscription through Stripe with a period ending in 30 days.
- When: Stripe sends to `POST /api/webhooks/stripe`: a `customer.subscription.updated` with `cancel_at_period_end`; four mismatched setup checkouts (payment mode, no customer, another subscription, downgrade to `team`); a `billing_restore` setup checkout; a legacy `billing_downgrade` setup checkout targeting `limited-free-1`; an update attaching a cancel-ending schedule whose final phase ends at +60 days; `subscription_schedule.released`; an update attaching a second schedule ending at +90 days followed by `subscription_schedule.canceled`; and an update clearing `cancel_at_period_end`.
- Then: The first update shows a pending cancel to `limited-free-1` at the period end, and the mismatched checkouts leave it pending. The restore checkout sets `pm_bdd_restore` as the customer default, unsets `cancel_at_period_end` in Stripe, and clears the pending change. The downgrade checkout sets `pm_bdd_downgrade` as default, sets `cancel_at_period_end` in Stripe, and shows a pending cancel to `limited-free-1`. The schedule-managed update moves the period end and cancel date to +60 days; releasing it clears the cancellation. After the second schedule is canceled, the pending change is a cancel effective at +90 days. The final uncancel update clears both the flag and the pending change.

## webhooks-callbacks.bdd-052

- Vitest: "WHCB-07: Stripe billing lifecycle webhooks > processes preview Stripe events only for the matching job ref"
- Mode: run
- Given: A member's workspace holds a Pro subscription through Stripe (20,000 credits). The API runs as a preview environment with job ref `pr-bdd-123`. The Stripe customer's metadata first names preview job ref `pr-bdd-456`, later `pr-bdd-123`, and the card payment method belongs to the customer.
- When: Stripe sends to `POST /api/webhooks/stripe` events tagged with job ref `pr-bdd-456`: `payment_intent.succeeded`, `invoice.paid`, `checkout.session.completed` and `customer.subscription.created`. It then sends an `invoice.paid` and a `payment_intent.succeeded` tagged with `pr-bdd-123`.
- Then: Every webhook returns HTTP 200. The mismatched events do not update the customer, and billing stays at 20,000 credits with an active subscription. The matching invoice raises credits to 40,000, and the matching payment sets the card as the customer's default payment method.

## webhooks-callbacks.bdd-053

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > retains organization state and OAuth sessions after a verified organization.deleted event"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro workspace has an OpenAI connector, an org custom manual connector with a secret and skill, a custom OAuth connector, pending Slack and custom OAuth authorizations, a running thread Run on a Runner, and an installed GitHub App. Stripe lists the active Pro subscription, then the canceled one. A second workspace was bootstrapped on limited free with no subscription.
- When: Clerk posts a verified `organization.deleted` for the Pro workspace to `POST /api/webhooks/clerk`; the pending Slack and custom OAuth callbacks are then completed; finally Clerk posts a verified `organization.deleted` for the limited-free workspace.
- Then: The first webhook returns HTTP 200 `OK`, and the API cancels the Pro subscription in Stripe without invoicing or proration, using idempotency key `org-delete:<orgId>:<subscriptionId>:cancel`. The Runner's `GET /api/runners/runs/:runId/cancellation` reports a present hard cancellation. Both pending OAuth callbacks still complete with status `success`. The limited-free deletion makes no Stripe subscription updates.

## webhooks-callbacks.bdd-054

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > preserves org data when a deleted user leaves an uncached Clerk member"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro workspace's admin is being deleted, and Clerk reports one remaining member (a peer) in the organization.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200 `OK`. The organization is not deleted in Clerk, Stripe subscriptions are neither updated nor cancelled, and the peer still reads billing as tier `pro` with an active subscription.

## webhooks-callbacks.bdd-055

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > revokes deleted-user pending inputs without launching them when capacity returns and retains shared history"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro admin has three running thread Runs and a chat input queued at capacity, and has shared a thread snapshot containing one prompt event. A peer member in the same workspace has completed onboarding and has a chat input queued at capacity.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`; the peer then starts another thread Run, and the shared snapshot is read again.
- Then: The peer's queued input starts a Run that reads `running`. The run queue shows 2 active Runs, the peer's member usage is 2 active, and the deleted admin has 0 active. The shared snapshot reads back identical to before the deletion.

## webhooks-callbacks.bdd-056

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > disarms only the deleted user's automations across organizations and preserves their configuration"
- Mode: run
- Given: The Clerk webhook secret is configured. A user belongs to two Team workspaces, and an admin in the first workspace is another user. Each of the three creates a workflow with an enabled loop schedule automation and an enabled `webhook-received` event automation.
- When: Clerk posts a verified `user.deleted` for the shared user to `POST /api/webhooks/clerk`, and workspace admins read each automation.
- Then: Each automation reads back unchanged except that the deleted user's four automations (in both workspaces) are disabled and the other user's two remain enabled. No organization is deleted in Clerk.

## webhooks-callbacks.bdd-057

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > verified user.deleted retention > preserves peer connector accounts and grants after a verified user-deletion webhook"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro workspace's admin and a peer member each connected OpenAI by API key. The admin created a user-scoped custom manual connector; both set their own secret on it, and the admin selected it in a thread. The admin allows `conversations:read` and the peer denies `chat:write` on that connector. Clerk reports the peer as the only remaining member.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200 `OK`. The peer's permissions on the custom connector still contain exactly one grant, a `chat:write` deny. The peer's custom connector account remains default and `connected`, and the peer's OpenAI accounts are unchanged. Stripe subscriptions are neither updated nor cancelled, and the peer reads tier `pro` with a subscription.

## webhooks-callbacks.bdd-058

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > verified user.deleted retention > keeps the peer's pending builtin and custom OAuth states usable during user deletion"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro workspace's admin created a user-scoped custom OAuth connector, and a peer member has started Slack OAuth and custom connector OAuth authorizations. Clerk reports the peer as the only remaining member.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`; the provider then completes the peer's Slack and custom OAuth callbacks.
- Then: The webhook returns HTTP 200 `OK`. Stripe subscriptions are neither updated nor cancelled, and the peer still reads billing as tier `pro` with a subscription. Both of the peer's OAuth callbacks complete with status `success`.

## webhooks-callbacks.bdd-059

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > verified user.deleted retention > retains the deleted user's Agents and another member's thread and run on them"
- Mode: run
- Given: The Clerk webhook secret is configured. In a Pro workspace, a peer member created a thread, completed onboarding and started a running Run on `claude-sonnet-5-5`; the admin also has a Run executing on a Runner. Clerk reports the peer as the only remaining member.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`; the peer then reads its thread and Run, and the Runner reads the admin's Run cancellation.
- Then: The webhook returns HTTP 200 `OK`. Stripe subscriptions are neither updated nor cancelled, and the peer still reads billing as tier `pro` with a subscription. The peer's thread and Run reads return HTTP 200. The Runner's `GET /api/runners/runs/:runId/cancellation` for the admin's Run reports a present hard cancellation.

## webhooks-callbacks.bdd-060

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > verified user.deleted retention > does not revoke the deleted user's GitHub grant while preserving the shared organization"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro workspace's admin installed the GitHub App with an OAuth grant, and the installation reads as connected. Clerk reports a peer as the only remaining member.
- When: Clerk posts a verified `user.deleted` for the admin to `POST /api/webhooks/clerk`.
- Then: The webhook returns HTTP 200 `OK`. Stripe subscriptions are neither updated nor cancelled, and the peer still reads billing as tier `pro` with a subscription. GitHub receives zero grant revocation requests.

## webhooks-callbacks.bdd-061

- Vitest: "WHCB-08: Clerk deletion webhooks stop execution and retain account history > suspends user-owned runs after a verified user.banned event"
- Mode: run
- Given: The Clerk webhook secret is configured. A Pro member has a running thread Run, and Stripe lists no further subscriptions.
- When: Clerk posts a verified `user.banned` for the member to `POST /api/webhooks/clerk`; afterwards the sandbox reports completion with exit code 137.
- Then: The webhook returns HTTP 200 `OK`. The Run reads `cancelled`, the Pro subscription is set to `cancel_at_period_end: true` in Stripe and not cancelled outright. The run queue shows 1 active Run while it stops and 0 after the sandbox completion.

## webhooks-callbacks.bdd-062

- Vitest: "Atom billing grants > grants and renews Atom invoice-backed Team entitlements"
- Mode: run
- Given: Stripe billing is configured, Stripe lists no subscriptions, and a member completed onboarding without credits.
- When: Stripe sends a signed `invoice.paid` to `POST /api/webhooks/stripe` carrying Atom grant metadata (Team tier, 7-day duration, expiring in 7 days) with a one-off grant-price line, then a renewal Atom grant invoice expiring in 14 days.
- Then: After the first invoice, billing shows tier `team`, 120,000 credits, no subscription, period end at the 7-day grant end, one 120,000 `subscription_renewal` grant expiring then, Team capabilities, and unlimited voice quota. After the renewal, billing shows 240,000 credits, no subscription, period end at the 14-day grant end, 120,000 grants expiring at 7 and 14 days, and Team capabilities.

## webhooks-callbacks.bdd-063

- Vitest: "Atom billing grants > expires Atom day-grant subscription credits at the Atom grant end"
- Mode: run
- Given: A member's workspace is granted Pro through Stripe with a period ending in 30 days, `cancel_at` in 7 days, and Atom entitlement metadata (source `atom_entitlement`, 7-day duration, grant end in 7 days).
- When: The member reads billing status.
- Then: The tier is `pro`, `currentPeriodEnd` is the Atom grant end, and there is one 20,000 `subscription_renewal` grant expiring at the Atom grant end.

## webhooks-callbacks.bdd-064

- Vitest: "Atom billing grants > expires Atom redeem-code day-grant subscription credits at the grant end"
- Mode: run
- Given: A member's workspace is granted Pro through Stripe with a period ending in 30 days, `cancel_at` in 7 days, and Atom redeem-code metadata (source `atom_redeem_code`, 7-day duration, grant end in 7 days).
- When: The member reads billing status.
- Then: The tier is `pro`, `currentPeriodEnd` is the grant end, and there is one 20,000 `subscription_renewal` grant expiring at the grant end.

## webhooks-callbacks.bdd-065

- Vitest: "Atom billing grants > uses the normal renewal credit window when an Atom day-grant cancel_at is cleared"
- Mode: run
- Given: A member's workspace is granted Pro through Stripe with a period ending in 30 days, no `cancel_at`, and Atom entitlement metadata with a 7-day grant end.
- When: The member reads billing status.
- Then: The tier is `pro`, `currentPeriodEnd` is the 30-day period end, and there is one 20,000 `subscription_renewal` grant expiring one month after the period end.

## webhooks-callbacks.bdd-066

- Vitest: "Atom billing grants > grants Atom organization credits once and rejects an untrusted grant price"
- Mode: run
- Given: Stripe billing is configured and a member completed onboarding without credits.
- When: Stripe sends a signed `invoice.paid` to `POST /api/webhooks/stripe` with Atom custom-credit metadata for 2500 credits expiring in 90 days on the configured zero-price Atom grant line, then another with metadata for 9000 credits on a different price.
- Then: The first invoice adds a 2500 `credit_purchase` grant expiring at the 90-day time (baseline plus 2500). The second invoice grants nothing, leaving baseline plus 2500.

## webhooks-callbacks.bdd-067

- Vitest: "Atom member credit grants > delivers member credits once without changing a purchased Pro plan"
- Mode: run
- Given: A member's workspace holds a purchased Pro plan through Stripe, and Stripe billing is configured.
- When: Stripe delivers the same signed `invoice.paid` twice to `POST /api/webhooks/stripe`, carrying Atom usage-pack metadata granting the member 6000 credits expiring in 7 days on the Atom grant price; the member then reads `GET /api/billing/usage-pack-credits`.
- Then: Usage-pack credits total 6000 bonus credits (0 purchased) in a single `bonus` grant of 6000 with 6000 remaining, expiring at the 7-day time. The workspace billing status is identical to before the invoices.

## webhooks-callbacks.bdd-068

- Vitest: "Atom usage-pack redemption > publishes pro plan and member credits exactly once"
- Mode: run
- Given: Stripe billing is configured, Stripe lists no subscriptions, and a member completed onboarding without credits.
- When: Stripe delivers the same signed `invoice.paid` twice to `POST /api/webhooks/stripe`, carrying Atom redeem-code usage-pack metadata for the `pro` plan (7-day duration) and 20,000 member credits for the member, expiring in 7 days, on the Atom grant price; the member then reads billing status and `GET /api/billing/usage-pack-credits`.
- Then: Billing shows tier `pro`, 0 organization credits, no subscription, subscription status `atom_grant`, period end at the grant end, and `showUsagePack: true`. Usage-pack credits total 20,000 bonus credits in a single grant of 20,000 with 20,000 remaining, expiring at the grant end.

## webhooks-callbacks.bdd-069

- Vitest: "Atom usage-pack redemption > publishes team plan and member credits exactly once"
- Mode: run
- Given: Stripe billing is configured, Stripe lists no subscriptions, and a member completed onboarding without credits.
- When: Stripe delivers the same signed `invoice.paid` twice to `POST /api/webhooks/stripe`, carrying Atom redeem-code usage-pack metadata for the `team` plan (7-day duration) and 120,000 member credits for the member, expiring in 7 days, on the Atom grant price; the member then reads billing status and `GET /api/billing/usage-pack-credits`.
- Then: Billing shows tier `team`, 0 organization credits, no subscription, subscription status `atom_grant`, period end at the grant end, and `showUsagePack: true`. Usage-pack credits total 120,000 bonus credits in a single grant of 120,000 with 120,000 remaining, expiring at the grant end.
