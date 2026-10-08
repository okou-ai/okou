# Chat Event Snapshot candidate timeout diagnostics

The global Chat Event Snapshot sweep archives one thread per candidate under a
30-second per-head deadline, eight workers, and a two-minute start budget. That
deadline is designed backpressure so a slow head cannot block unrelated
convergence; it is not a failure signal.

A candidate that reaches its deadline is logged at **info** with
`type=chat_event_snapshot_candidate_timed_out` and `expected=true`, plus the
coarse `stage` it had reached (`resolve_prefix`, `read_events`, `compress`,
`put_object`, or `publish`), `durationMs`, and `timeoutMs`. The outcome is
still unsuccessful: the candidate contributes to `skippedTimedOutHeads` on the
terminal `chat_event_snapshot_completed` event and publishes no pointer.

This is a log-level classification, not a deadline extension, an error filter,
or a retry change. `chat_event_snapshot_candidate_failed` stays at **error**
with its inner error, and now also carries `stage`. Deferred, unreadable,
undecodable, and incomplete heads keep their existing classification, and
request cancellation still propagates instead of being recorded as a timeout.

## Why downgrading is safe

- **Convergence.** The scan cursor advances past a timed-out candidate, so the
  head is retried on the next `lastMessageAt`-fenced cycle rather than the next
  invocation. Recovery is bounded by one full cursor cycle, not by a constant.
- **Retention.** Chat Event retention deletes a Raw Event only when a
  current-schema Snapshot with `last_seq_id >= event.seq_id` and a conforming
  object key exists. An un-archived head therefore blocks its own reclamation;
  a repeated timeout delays retention and can never lose events.
- **Publication.** The exact-pointer CAS remains the only publication owner. A
  deadline that fires around publication can leave a collectable orphan object
  or record a timeout for a head that actually published, but it cannot move
  the pointer incorrectly.
- **No absorbed failures.** `awaitWithSignal` settles the deadline race with
  the deadline's own reason, so the timeout branch cannot swallow an unrelated
  archive error. Genuine failures reject before the deadline and keep the error
  path.

## Alerting

Alert on sustained lag, never on a single timeout. The terminal event carries
`skippedTimedOutHeads`, `skippedFailedHeads`, `selectedCandidates`,
`deferredCandidates`, `scanWrapped`, and `oldestCandidateAgeMs` — the age of
the least recently updated candidate **in that invocation's batch**. Global
discovery selects candidates in thread-ID order, so a single invocation sees
one slice of the eligible set and the per-invocation value varies with batch
composition. Aggregate it as a maximum over a window: a stuck head keeps
reappearing every cycle with a `lastMessageAt` that never moves, so its age
grows monotonically, while an isolated deadline leaves no trend.
Warn/error-only queries do not contain the downgraded info events.

## Rollout verification

Keep [#33088](https://github.com/vm0-ai/vm0/issues/33088) open after this
change. Record the deployed API revision and observe a bounded window, then
check that the warn/error feed carries no
`chat_event_snapshot_candidate_timed_out` records, that any info record carries
a non-empty `stage` and `durationMs`, that `chat_event_snapshot_completed`
keeps its cadence with `skippedFailedHeads` at zero, and that the windowed
maximum of `oldestCandidateAgeMs` shows no sustained upward trend.

The observed base rate is roughly one timeout per 40,000 candidates, so a quiet
window without an exercised timeout is not recovery evidence. Correlate at
least one real downgraded event and record the limitation otherwise. A private
snapshot test driver is not user-public acceptance evidence; the
[testing boundary](testing/testing-external-behavior.md) does not permit forcing
an internal archive sweep to manufacture a user scenario.
