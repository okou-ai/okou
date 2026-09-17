# Event Sourcing and Optimistic Events

This guide defines how the frontend combines persistent events with optimistic
events. It applies to event-sourced chat content, thread metadata, and other
frontend projections that show a local event before the server round trip
finishes.

## Event Roles

Persistent events are durable server facts. They have the server-owned ordering
and are the authoritative input when the frontend rebuilds a projection from an
event log or snapshot.

Optimistic events are page-local projections created before persistence
completes. They make user actions and streamed assistant text visible immediately, but they are
not a second source of truth and do not have server ordering.

## Normal Reconciliation

For user actions, the frontend creates an event ID, appends an optimistic event with that ID, and
passes the same ID to the server mutation. When the corresponding persistent
event arrives through the normal event stream:

1. The projection prefers the persistent event and filters out the optimistic
   event with the same ID.
2. Reconciliation removes that matching optimistic event from the page-local
   buffer.

This persistent-event match is the only in-session cleanup path for optimistic
events. The persistent event remains authoritative even if it arrives through a
later sync rather than the mutation response.

## Failure Semantics

The frontend must not remove or roll back an optimistic event merely because a
request fails, aborts, times out, returns no persistent lifecycle event, or
otherwise takes an exceptional path. Do not add error-handler cleanup,
`finally` cleanup, fallback timers, or heuristics that guess whether an
optimistic event should be deleted.

These exceptional inconsistencies are rare. Maintaining a second rollback
lifecycle for them adds defensive complexity and can remove an event that was
persisted but has not reached the client yet. A stale optimistic projection is
recoverable: refreshing the page discards page-local optimistic state and
reloads the authoritative persistent state, restoring eventual consistency.

## Session Output Streaming

API-first Pi turns can publish sanitized text deltas on a separate
`run-output:<userId>:<orgId>:<runId>` Ably channel. Thinking and private memory
citation markup are excluded. The `piLoop` feature switch controls both Pi
runtime admission and the frontend subscription. A visible chat panel subscribes
while it has a pending or running run; queued runs do not subscribe. Run changes,
page cancellation, and switch changes reset that subscription. The SharedWorker
shares the transport across tabs and releases the channel attachment when its
final subscriber leaves.

Each API attempt assigns `api-first:<attemptId>:<nativeContentIndex>` as the
text block's `runEventId`. Streaming and final event insertion derive the same
chat event UUID from the run ID and that source ID. The independent public
event sequence still determines ordering and the sandbox handoff boundary.
Filtering thinking or empty text therefore cannot shift a streamed block's
identity, and sandbox fallback cannot reuse an abandoned attempt's identity.

Chunk zero creates an optimistic `output.message`. Later chunks append only
when that optimistic event exists. A persistent event with the same ID always
wins, including over late packets. Chunk indices have no gap detection or
replay semantics. Refreshing after missing chunk zero waits for the normal
durable output. Deltas are never written to the database, IndexedDB, or an
event log. The API publishes deltas through the shared Ably REST client;
publication does not depend on frontend subscriptions.

## Review Checklist

- The originating event ID is reused by the server mutation or final output insertion.
- Persistent and optimistic projections deduplicate by that shared event ID.
- Persistent events are the only normal trigger for removing matching
  optimistic events.
- Failure, cancellation, timeout, and missing-event paths do not imperatively
  remove optimistic events.
- A page refresh remains the recovery path for rare exceptional inconsistency.
