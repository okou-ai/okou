# Link approval continuation

One Cloudflare Workflow watches one existing purchase intent. Only
the spend UUID and its original `expiresAt` enter durable Workflow state. Link
OAuth tokens and card credentials stay in the API. This Worker never pays.

The API records the originating web run/thread before asking Link for approval.
Once Link returns a request that can continue after approval, it starts the
Workflow. The existing per-minute background-job Cron repairs missed starts
and failed instances using the same spend UUID. Cron does
not poll Link. Completed instances are retained for one day, longer than the
entire recovery window.

Each `step.do` polls the authenticated short API every five seconds for up to
one minute, using ordinary timers between requests. Approval ends the block
immediately. Waiting consumes no CPU time, but the instance remains active for
Cloudflare concurrency limits. The absolute 30-minute deadline never resets.
A final status check has a two-minute recovery allowance for transient failures;
after that an unknown result is not interpreted as denial. The existing spend
remains available for an explicit manual status check.

An approved request waits for the current chat run to finish, then enqueues the
agreed continuation text in the original thread. The spend UUID is the input ID.
Manual continuation records a revoke edge for that same input. The chat queue's
unique revoke constraint arbitrates both admission and active-input consumption,
so retries cannot start a second purchase continuation. Watched purchases must
continue in their original thread. Ordinary approval status is still rechecked
before credentials are released; approval is not payment.

## Rollout

1. Apply additive migration `1417_link_approval_continuation`; old requests retain
   null provenance and their manual flow.
2. Configure separate, random secrets of at least 32 characters in the target
   GitHub environment: `LINK_APPROVAL_WORKER_SECRET` (Worker → API HMAC) and
   `LINK_APPROVAL_CONTROL_SECRET` (API → Worker). Set
   `LINK_APPROVAL_API_ORIGIN` to the canonical HTTPS API origin and
   `LINK_APPROVAL_WORKER_URL` to the deployed Worker origin. API environment
   assembly includes only the URL and secrets, never the web app.
3. Deploy the Worker with `link-approval-deploy.yml`, initially disabled. Deploy
   the API/platform/CLI and let older API instances drain. No Link credentials
   are configured on the Worker.
4. Enable the Worker explicitly, then enable `linkWalletApprovalContinuation`
   for a test user. Validate a Link test-mode spend, manual takeover, rejection,
   expiry, disconnect, and repeated `/start`/poll delivery before widening.

The feature and Worker both default off. Disable the feature to stop new and
in-flight watches; disable the Worker as well before rolling back the API.
Existing queued messages remain subject to normal wallet authorization checks.
Never roll back the additive migration while a newer API is serving traffic.

## Checks

From `turbo`: `pnpm --filter @okouai/link-approval-worker build`, then the worker
package's type, lint and Miniflare tests. No deployed infrastructure is needed
for these checks.
