# Chat Card UI Contracts

This guide defines reusable rendering, geometry, signal-registration, and
lifecycle rules. Recognized URL shapes, provider-specific flows, and individual
card behavior belong in their owning code, contracts, and tests, not a duplicated
feature catalog.

## Portable Action Links

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

## Registration and Ownership

Keep the pipeline explicit:

```text
message content
  -> pure trusted-link descriptor
  -> stable resource key
  -> signal registration at the write/command boundary
  -> render block carrying the registered signals
  -> React presentation
```

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

Follow [ccstate](../../.claude/skills/ccstate/SKILL.md), [effects](effect.md), and
[cache/lifecycle](cache.md) for graph construction, cancellation, and teardown.

## Fixed Height and Stable Layout

At a given available width, a transcript card keeps stable outer geometry across
asynchronous updates. Different card types and responsive breakpoints can have
different dimensions. Synchronous row structure can determine natural height;
reserve space only for content an asynchronous read can introduce. Explicit
user-owned expansion, such as an inline form, is a separate layout action.

### Keep the Frame Mounted

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
[`connector-account-action-card.tsx`](../../turbo/apps/platform/src/views/okou-page/connector-account-action-card.tsx)
for the persistent-frame pattern and
[`attachment-preview.tsx`](../../turbo/apps/platform/src/views/okou-page/attachment-preview.tsx)
for reserved artwork/preview geometry.

### Reserve Only the Required Geometry

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

### No Content-Size Observation or Compensating Scroll

Do not introduce `ResizeObserver`, mutation observers, or timer/frame loops to
watch card/transcript content dimensions and repair scrolling afterward. Do not
compensate for async height changes with `withChatScrollLayout` or
`restoreScrollPosition$` on every update. Preserve geometry directly.

The transcript continues to own scrolling for new messages, navigation, folding,
viewport changes, and composer layout. These causes do not relax the card
contract. A reader following the tail stays at the bottom; a reader reviewing
history retains their position without card-specific corrections. See
[ResizeObserver](resize-observer.md) and [styles](styles.md).

## Verification

Exercise delayed responses, errors/retries, unavailable resources, action
completion, and background refresh at supported widths. Verify the same outer
DOM frame remains mounted, height is unchanged, and content/actions remain
inside the reserved geometry.

Browser checks must observe scroll results, not only final CSS classes or
heights: bottom gap and bottom-arrow state while following the tail, and visible
message position while reading history. Cover cold/warm navigation, long text,
narrow layouts, WebKit, and Chromium.

The existing
[`chat-card-scroll.ts`](../../e2e/playwright/regressions/chat-card-scroll.ts)
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
Follow [Platform testing](app-testing.md).
