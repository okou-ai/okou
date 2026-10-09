# Chat Design

Chat combines a durable event history, immediate optimistic output, and a
transcript that can enhance action links into interactive cards. This guide
connects those layers and defines their shared identity, rendering, and
lifecycle contracts.

## Architecture and Ownership

- **Event history:** persistent server events own durable facts and ordering.
  The frontend rebuilds chat content and thread metadata from that history or
  its snapshot.
- **Immediate presentation:** page-local optimistic events show user actions
  and streamed assistant text before persistence completes. Shared event IDs
  reconcile them with durable events; they do not become another source of truth.
- **Transcript projection:** message content produces render blocks and trusted
  link descriptors. The transcript owns occurrence identity, card registration,
  insertion, removal, folding, and scrolling.
- **Card resources and actions:** registered signals own a scoped resource's
  asynchronous work under the page or thread lifetime. React presents that
  state in a stable frame. Direct action routes retain authentication,
  authorization, confirmation, and completion ownership outside the card.

Read [event sourcing and optimistic events](#event-sourcing-and-optimistic-events)
for persistence and streaming, and [chat cards](#chat-cards) for link enhancement,
resource ownership, and layout. Follow [React](react.md),
[Platform ccstate](app/platform-ccstate.md), and
[cache/lifecycle](react.md#cache-and-resource-lifetimes) for the underlying framework rules.

## Event Sourcing and Optimistic Events

The frontend combines persistent events with optimistic events for chat content
and thread metadata. The same rules apply to other frontend projections that
show a local event before the server round trip finishes.

### Event Roles

Persistent events are durable server facts. They have the server-owned ordering
and are the authoritative input when the frontend rebuilds a projection from an
event log or snapshot.

Optimistic events are page-local projections created before persistence
completes. They make user actions and streamed assistant text visible
immediately, but they are not a second source of truth and do not have server
ordering.

### Normal Reconciliation

For user actions, the frontend creates an event ID, appends an optimistic event
with that ID, and passes the same ID to the server mutation. When the corresponding persistent
event arrives through the normal event stream:

1. The projection prefers the persistent event and filters out the optimistic
   event with the same ID.
2. Reconciliation removes that matching optimistic event from the page-local
   buffer.

This persistent-event match is the only in-session cleanup path for optimistic
events. The persistent event remains authoritative even if it arrives through a
later sync rather than the mutation response.

### Failure Semantics

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

### Session Output Streaming

Sandbox runs can publish sanitized text deltas through the session-output
webhook on a separate
`run-output:<userId>:<orgId>:<runId>` Ably channel. Thinking and private memory
citation markup are excluded. Pi runtime admission follows the route policy.
A visible chat panel subscribes while it has a pending or running run; queued
runs do not subscribe. Run changes and page cancellation reset that subscription.
The SharedWorker shares the transport across tabs and releases the channel
attachment when its final subscriber leaves.

Streaming and final event insertion derive the same chat event UUID from the
run ID and the delta's `runEventId`. The independent public event sequence
still determines ordering.

Chunk zero creates an optimistic `output.message`. Later chunks append only
when that optimistic event exists. A persistent event with the same ID always
wins, including over late packets. Chunk indices have no gap detection or
replay semantics. Refreshing after missing chunk zero waits for the normal
durable output. Deltas are never written to the database, IndexedDB, or an
event log. The API publishes deltas through the shared Ably REST client;
publication does not depend on frontend subscriptions.

### Review Checklist

- The originating event ID is reused by the server mutation or final output
  insertion.
- Persistent and optimistic projections deduplicate by that shared event ID.
- Persistent events are the only normal trigger for removing matching
  optimistic events.
- Failure, cancellation, timeout, and missing-event paths do not imperatively
  remove optimistic events.
- A page refresh remains the recovery path for rare exceptional inconsistency.

## Chat Cards

Cards enhance transcript links with interactive presentation. The rules below
define their rendering, geometry, signal registration, and lifecycle ownership.
Recognized URL shapes, provider-specific flows, and individual card behavior
belong in their owning code, contracts, and tests, not a duplicated feature
catalog.

### Portable Action Links

Web Chat may enhance a trusted URL into an interactive card, but other surfaces
show the original link. Its direct destination must remain usable outside Web
Chat and enforce authentication, URL claims, and current action state. Do not
make completion depend on a mounted card. An in-chat dialog can improve the
interaction without replacing the direct route.

Only promote a streaming bare URL once a following boundary proves that later
text cannot extend its path or query. A syntactically closed Markdown link or
image can be recognized immediately. Re-evaluate a durable replacement even if
its text is unchanged: a final bare URL needs no following boundary.

Preserve user-facing action URLs exactly, including every query parameter.
Rendering or opening a link must not execute an action whose owner requires
explicit user confirmation.

### Registration and Ownership

Keep the pipeline explicit:

1. Parse message content into a pure trusted-link descriptor.
2. Derive a stable resource key.
3. Register signals at the write/command boundary.
4. Produce a render block carrying the registered signals.
5. Present the block in React.

Parse without writes or signal allocation. Derive keys from the actual resource
identity; include the distinctions needed for account, permission, or operation
scope. Register signals before React renders and reuse them for the same scoped
resource. Never allocate signal graphs during render or mutate a registry from
a parser/computed read.

The transcript owns registration, occurrence identity, insertion, removal, and
folding. A card owns its resource/action lifetime under the correct page or
thread signal. Keep subscriptions and polling in that owner, including while a
presentation dialog is closed. Do not move action ownership into a details
viewer or let stale thread work update a replacement card.

Follow [ccstate](../.claude/skills/ccstate/SKILL.md), [effects](react.md), and
[cache/lifecycle](react.md#cache-and-resource-lifetimes) for graph construction, cancellation, and teardown.

### Fixed Height and Stable Layout

At a given available width, a transcript card keeps stable outer geometry across
asynchronous updates. Different card types and responsive breakpoints can have
different dimensions. Synchronous row structure can determine natural height;
reserve space only for content an asynchronous read can introduce. Explicit
user-owned expansion, such as an inline form, is a separate layout action.

#### Keep the Frame Mounted

Choose geometry before the first asynchronous read and keep one outer DOM frame
mounted for the occurrence's lifetime. Loading, ready, refreshing, error,
unavailable, completion, and retry replace its contents, not the frame.

Do not return `null` after reserving a resource slot. Show an inert unavailable or
retry state inside that slot. Equal final heights are insufficient if React
replaces the entire sized element: transient collapse can make WebKit clamp
scroll position and displace the reader.

Read async state into content—icon, copy, status, and actions—rather than
conditionally switching between pending and ready component types. An unsized
wrapper around replaceable sized children can still collapse. `min-height`,
equal-sized skeletons in separate branches, and retained last data do not prove
that the mounted frame is preserved.

The shared `ChatCard` supplies surface styling, not automatic height/lifetime
ownership. Each card owner must satisfy the contract. See
[`connector-account-action-card.tsx`](../turbo/apps/platform/src/views/okou-page/connector-account-action-card.tsx)
for the persistent-frame pattern and
[`attachment-preview.tsx`](../turbo/apps/platform/src/views/okou-page/attachment-preview.tsx)
for reserved artwork/preview geometry.

#### Reserve Only the Required Geometry

- Bound title, summary, status, and action areas before asynchronous data arrives.
  A spinner, account label, terminal status, or new control cannot silently add
  height or remove an action reservation.
- Keep required controls, identity, scope, and confirmation readable and
  reachable. Clipping them is not a valid fixed-height solution.
- Long raw diagnostics and expanded documents belong in accessible details
  surfaces. Do not duplicate short visible copy behind redundant controls or
  move the actual recovery action into a details dialog.
- Reserve media width/aspect ratio and any fixed header before images, metadata,
  or iframes load. Loading and error content occupies the same area; natural
  resource dimensions cannot resize it.
- Allow localized copy and controls to wrap within their allocated geometry.
  Do not reserve hypothetical rows that no async read can introduce.
- Preserve the existing deliberate user-expansion exception without making all
  asynchronous states expandable.

#### No Content-Size Observation or Compensating Scroll

Do not introduce `ResizeObserver`, mutation observers, or timer/frame loops to
watch card/transcript content dimensions and repair scrolling afterward. Do not
compensate for async height changes with `withChatScrollLayout` or
`restoreScrollPosition$` on every update. Preserve geometry directly.

The transcript continues to own scrolling for new messages, navigation, folding,
viewport changes, and composer layout. These causes do not relax the card
contract. A reader following the tail stays at the bottom; a reader reviewing
history retains their position without card-specific corrections. See
[ResizeObserver](app/resize-observer.md) and [styles](app/styles.md).

### Verification

Exercise delayed responses, errors/retries, unavailable resources, action
completion, and background refresh at supported widths. Verify the same outer
DOM frame remains mounted, height is unchanged, and content/actions remain
inside the reserved geometry.

Browser checks must observe scroll results, not only final CSS classes or
heights: bottom gap and bottom-arrow state while following the tail, and visible
message position while reading history. Cover cold/warm navigation, long text,
narrow layouts, WebKit, and Chromium.

The existing
[`chat-card-scroll.ts`](../e2e/playwright/regressions/chat-card-scroll.ts)
regression checks persistent-frame geometry and reading position against a
prepared preview with private authenticated storage state:

```sh
cd e2e
pnpm exec tsx playwright/regressions/chat-card-scroll.ts \
  <app-origin> <api-origin> <thread-id> <storage-state.json> <output-dir> \
  recovery 1
```

Choose the appropriate family/count and an overflowing thread. This read-only
loading check does not authorize actions or establish their completed/error
behavior; cover those through page tests and authorized preview acceptance.
Follow [Platform testing](app/app-testing.md).
