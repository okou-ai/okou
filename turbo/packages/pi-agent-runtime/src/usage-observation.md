# API turn usage evidence

The API runtime returns `usageObservation` separately from
`assistantMessage.usage`. It observes provider bytes, so SDK-initialized zeros
cannot become provider-reported zero. This metadata is content-free and is
never appended to Pi session history. Existing assistant counters, billing,
provider requests and retry policy are unchanged.

`tokens` contains disjoint `input`, `cacheRead`, `cacheCreation` and `output`
quantities. A field is a nonnegative safe integer or `null` when its value is
unknown. `coverage` is:

- `complete`: a terminal usage boundary established every category, the sum is
  safe, and no observation loss or execution failure occurred.
- `partial`: some quantities are known, but a category, terminal boundary or
  part of the observation is missing. These quantities are not a complete run
  total.
- `unavailable`: no usable quantities were observed, or distinct response
  identities made the evidence ambiguous.

Responses and Codex input includes cached input. Ordinary input is calculated
only when both cache partitions are known and fit within inclusive input.
Absent cache details remain unknown; no SDK default is copied. Inclusive input
of zero proves zero cache partitions unless explicit contradictory/invalid
values were supplied. Messages and Bedrock report disjoint input and cache
quantities. Messages deltas replace only supplied fields and require final
output evidence plus `message_stop` for complete coverage. Repeated cumulative
snapshots replace quantities rather than adding them.

Codex observation ends at the first terminal event, matching the pinned SDK's
consumption boundary. Later bytes in the same network chunk cannot replace that
result or downgrade its coverage. Original transport bytes are still forwarded.

Each execution owns its observer. Responses/Codex and Messages use a passive
fetch stream transform. Bedrock decorates the existing Smithy HTTP handler,
preserving its proxy, DNS, credentials and cancellation policy. Smithy's event
codec validates frame lengths, headers and CRCs. The observer forwards the
original bytes and never tees a body or reads ahead independently of the SDK.

One frame buffer is capped at 256 KiB. Oversized SSE frames are skipped until
the next event boundary; invalid/oversized AWS frame lengths stop observation
because resynchronization is not trustworthy. Parsing/framing loss and multiple
HTTP responses prevent complete coverage. Provider errors/aborts preserve
known quantities as partial evidence. A thrown `PiApiModelRequestError` also
carries the current observation, without changing its failure classification.
Late returned runtime results contain the same metadata, with no publication
or lifecycle side effects.

The result field is optional because existing durable recovery can reconstruct
a result from a historical producer receipt without this evidence. Its absence
means unavailable, never zero. No persisted or guest handoff schema changes in
this capability. Issue #34787 owns persisting evidence, binding exact run/attempt
identity and revisions, normal/late API lifecycle convergence, and authorized
Runner reads. This runtime observation alone does not expose run token usage.
