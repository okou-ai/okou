# Chat model prefetch

The model group shares request-scoped facts between direct-send validation,
organization capacity and Thread run preparation. It is independent of the
connector prefetch changes.

## Captured facts

- Organization plan capabilities reuse the authenticated request's read.
- Organization credits and model mode are captured together.
- The model catalog (model rows and routes) reuses the send's catalog.
- Organization model policies are captured once.
- Connected member model accounts, their configured model and encrypted
  account secrets are captured in one joined query. Route selection, account
  capture, framework fallback and the selected member source reuse those rows.
- Subscription routing derives from the captured catalog instead of joining
  model routes to the catalog again.

Organization and member promises travel separately from the Agent bootstrap:
model consumers never wait for the complete connector/workflow package.
The send awaits model facts before enqueue, so these queries do not compete
with its enqueue transaction. Read failures propagate without rereading.

## Identity and missing prefetch

Organization facts are reusable only for the same organization. Member facts
also require the same user and Agent as the picked head. A different head gets
one local member loader; organization facts remain shared across one pick.
A pick without a request prefetch starts the organization loader with its
capacity check. The member loader starts when the execution identity is known.
No process-level cache or snapshot age policy is introduced.

## Credit admission

Ethan explicitly approved using the prefetched credit balance on October 2, 2026. Both preparation admission checks use that balance, not a new organization
balance query. Expired-credit and usage-pack calculations retain their existing
reads. The snapshot can be stale if another run spends credits or a payment
arrives before admission; that window is intentional.

The persisted free-plan credit-admission bit also derives from the captured
plan. Model-account transaction validation, thread/session and queue fences,
and official-workflow admission remain intact. This change does not add a
replacement lock or retry.

## Scope and verification

This is the model group only (plan, metadata, model catalog/routes, policies and
member accounts). Agent reads that join organization metadata, connector facts,
official workflows, storage, allowances and thread/message reads are separate
groups; this PR does not claim the entire endpoint meets the no-duplicate-query
terminal state.

The route regression pauses credit-expiry admission after the balance snapshot,
adds credits through the Stripe webhook, and verifies the queued input is still
rejected using its original balance. Existing web/CLI, model selection, account
and queue tests remain CI coverage. Production savings (previously estimated
at 50–90 ms) require post-deployment traces and are not measured by this PR.
