# Native Browser input CDP diagnostics

This is an **investigation aid**, not a retry or availability guarantee. Issue
[#36999](https://github.com/okou-ai/okou/issues/36999) tracks intermittent
preview timeouts; the diagnostic change in #37001 does not resolve their cause.

## Reading stage observations

Native-input preflight and apply report an operation-local random `attemptId`,
`operation`, `phase`, `outcome` and rounded `durationMs` in structured API logs.
A preflight also retains the aggregate `target` phase for comparison with older
logs. Its `targets`, `attach` and `frame` child observations describe the **same
attempt**, not additional failures. They correspond to `Target.getTargets`,
`Target.attachToTarget`, and `Page.getFrameTree`. `discovery` is the CDP
`/json/version` request and `connection` the WebSocket opening. `controls` is
control resolution; `validation` applies only where a separate pre-write value
check is needed. An apply failure observation records only whether a write may
have started (`writeStarted`). If `writeStarted` is true, treat website side
effects as ambiguous and never automatically retry.

An `attach` observation also reports `attachReplyObserved`, a Boolean captured
by a short-lived, passive listener on the same WebSocket before the command is
sent. `true` means a valid matching command reply reached the socket, even if
the command waiter failed; `false` means the observer did not see one, **not**
that the provider never sent it. Neither the reply nor any IDs are retained.
This distinguishes a possible local receive-loop gap from an upstream missing
reply without changing command handling or retries.

These observations contain no CDP URLs, target/node/session IDs, selectors,
request tokens, user input, file names/bytes or credentials. Fast successful
stages are debug-level; slow or failed stages are warning-level. A missing
debug event is **not** evidence that a command was skipped. The 15-second CDP
operation deadline is shared across stages; a child-stage duration close to
15 seconds does not justify increasing the deadline without further evidence.

## Bounded preview comparison

Use a disposable preview/staging organization, a fresh managed Browser and a
non-submitting test page with a pending exact native-input request. Do not use
production credentials or customer files. For each viewer configuration (no
additional live-view panel, then two concurrent panels), perform at most five
read-only preflights and one guarded apply on a **fresh request**. If a
preflight fails, confirm the action is still pending and explicitly run a
fresh preflight before applying; if apply reports `uncertain`, stop and inspect
the website without replaying it. Keep a finite UTC time window and record only
HTTP status/error code, action state, safe per-attempt stage/outcome/duration,
and website-side event count. Never record control values, target identity,
CDP URL or bytes in logs or a public issue comment.

Compare target-list, attach, frame and controls timings separately from
provider-session, discovery and connection. A run with no timeouts is
inconclusive for an intermittent failure. A temporal difference between viewer
configurations is not causal evidence by itself; reproduce or correlate with
provider/relay diagnostics before changing connection ownership or retry rules.
The separately observed 502 apply from #36999 has no known stage and must not
be assumed to be the same as the preflight timeouts.
