# Personalized follow-up suggestions

The `personalizedFollowups` switch enables a small preference feedback loop for
chat suggestions. It is disabled by default. The first version records submitted
web-chat inputs, builds a bounded preference summary in background work, and
reads that summary when generating subsequent follow-ups.

## Submission and evidence

Picking a suggestion continues to select or append text in the composer. An
editor-local ProseMirror plugin records the originating follow-up event ID and
item index. Partial edits preserve that origin; complete removal or replacement
drops it. References are not serialized into saved drafts or public message
documents. Restoring a draft therefore does not reconstruct an uncertain origin.

The normal send request accepts optional `followupOrigins`, with at most three
event/index pairs. The API resolves those suggestions under the sending user's
thread and organization. A missing, stale or foreign reference does not reject
the user's message; it cannot establish a reliable adoption signal.

Accepted, eligible plain-text web inputs create bounded sidecar evidence in the
same database transaction as their input event. A completed run activates the
evidence for the input it consumed. Queued inputs that are recalled, rejected
inputs, automation messages and unsupported structured inputs do not teach the
profile. Callback retries cannot activate the same input twice.

Evidence distinguishes unattributed, unchanged adopted, edited, mixed and unresolved
text. Here, unattributed means that no recommendation origin is known; it does not
prove independent authorship of pasted text or restored drafts. Recurring
observations are required before inferring a writing preference. Unchanged
model-written suggestions provide only weak intent evidence;
they cannot establish the user's own writing style. Edited text is supplied with
its original suggestions so the extractor can distinguish actual changes. Click
and impression telemetry remain analytics, not learning authority.

The learner starts with inputs captured after activation. Historical clicks lack
reliable submission attribution and are not retroactively labeled as adoption.
Existing conversation context continues to inform every recommendation.

## Preference projection

`followup_evidence` holds bounded input excerpts and validated origin references.
`followup_user_profiles` holds the preference summary and its coalescing job
state. Both are scoped to the canonical user and organization.

Five newly completed samples make a profile eligible for refresh. The background
worker reads a bounded recent sample window and uses the existing fast-path model
and auxiliary-generation boundary. The selected evidence is capped at 4096
tokens. The summary is capped at 1200 characters and
300 tokens. Supported observations concern language, wording, brevity, output
format and context-specific next steps. They must not retain private task details
or infer identity, sensitive traits or standing authorization.

Refreshes use a claim token, lease and captured evidence version. New evidence
arriving during generation remains pending for the next refresh. Retries and
expired leases cannot publish an older worker's result over a newer claim.
Samples age out after 30 days; successful refreshes are coalesced for six hours.
Model generation runs outside database transactions.

Profile readers and writers observe account-erasure admission. Source-evidence
validation prevents a preference summary derived from deleted threads from being
used or republished. User and organization cleanup remove the associated profile
and evidence.

## Recommendation generation

The completed-run callback reads the current preference summary alongside its
ordinary follow-up generation. It does not wait for a new profile or query
analytics. Missing preferences use the ordinary conversation rules; lookup
failures are diagnosed without suppressing ordinary suggestions. Cancellation
continues to belong to the callback.

Historical preferences are quoted data in the generation input, below the fixed
rules and the current user's explicit request. Suggestions must remain relevant
to the latest decision, preserve meaningful alternatives, and never imply that
past choices grant permission for a current action.

Conversation context retains at most eight messages and 8000 content characters.
The latest assistant reply has a 4000-character allowance and the latest user
request has a reserved 2000-character allowance; other messages share the
remainder with a 700-character per-message cap. Long messages retain their start
and end, so final decisions and constraints survive truncation.

The public `output.followups` V1 document is unchanged. Its existing event ID and
item index identify each suggestion. No recommendation metadata is added to
immutable chat snapshots or passed to the agent as user-authored message content.

## Deployment and verification

1. Apply the additive database migration and deploy the API accepting optional
   origins, with the switch still disabled.
2. Deploy the prepared App and retain an origin-aware API as the rollback
   baseline before enabling the switch. Older Apps continue sending the existing
   request shape. An older API does not support new origin-bearing requests.
3. Enable for selected users, inspect the targeted checks and preference refresh
   behavior, then decide whether to expand access. Disabling the switch stops
   collection and personalized generation; ordinary suggestions continue.

The initial change includes no ranking model, experiment allocation or automated
global prompt rewriting. The existing analytics measure selection separately
from this server-owned learning evidence. Follow-up adoption uplift still
requires a controlled product experiment.
