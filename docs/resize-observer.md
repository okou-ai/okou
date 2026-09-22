# ResizeObserver Anti-Pattern

Keep layout in CSS and drive application changes through explicit commands.
Do not use `ResizeObserver` to discover the effects of changes the application
already owns, or as a generic loop that repairs layout and scrolling afterward.

This guide complements [effects and commands](./effect.md),
[ccstate lifecycle ownership](../.claude/skills/ccstate/SKILL.md),
[styles](./styles.md), and [stable chat cards](./chat-cards.md#fixed-height-and-stable-layout).

## Recognize the Anti-Pattern

The application changes its data or layout, React updates the DOM, and an
observer then tries to infer which business state or scroll position to update.
The cause was already known, but the observer makes its consequences depend on
a later browser notification.

Common forms include:

- Measuring width in JavaScript to select classes, breakpoints, or wrapping
  that CSS can express directly.
- Watching a container continuously because a known command can append
  messages, expand a section, resize a sidebar, or show a panel.
- Replacing a loading card's outer element, then compensating for the resulting
  scroll jump with an observer.
- Reconstructing message identity, order, or rail ticks from DOM measurements
  when those values already exist in application state.
- Treating every resize notification as a reason to restore scroll position
  without preserving whether the reader was following the tail or reading an
  earlier message.

Correct `disconnect()` cleanup, a stable ref, observing only the viewport, or
needing numeric measurements does not resolve this design problem. CSS being
unable to express the entire behavior is not sufficient justification either:
the measurement can still belong to an explicit command.

An observer is not a record of application transitions. A temporary collapse
can change the browser's scroll position even when the final size equals the
previous size. Equal-sized DOM replacements can also invalidate stored node
references without producing the expected size change.

## Use CSS for Layout

Use container queries for controls whose layout depends on their containing
panel, and natural flex wrapping when controls run out of room. Keep each
layout's breakpoint rule in one place instead of duplicating it in CSS and
JavaScript.

For the composer, follow the existing `composer-wide` variant described in
[the styles guide](./styles.md#the-composers-width). Do not introduce width
state or an observer to reproduce that rule.

## Invoke Commands at the Source of a Change

Identify the operation that changes the available space or content. That
operation must explicitly request the required measurement or scroll action.
Reuse the owning signals' commands instead of adding a callback registry or a
second event system to rediscover the same business transition.

| Change                                                        | Deterministic trigger                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Message append, optimistic replacement, or history prepend    | The command applying the event or history change, coordinated with its DOM commit |
| Editor document changes, including programmatic draft changes | The editor's document transaction completion                                      |
| Sidebar drag, panel visibility, or section expansion          | The command owning the change, coordinated with the affected DOM update           |
| A CSS transition that changes usable space                    | The relevant element's `transitionend` event                                      |
| Browser or mobile visual viewport resize                      | `window.resize` or `visualViewport.resize`                                        |
| Reading position changes                                      | The scroll container's `scroll` event                                             |

Wait for required styles and layout inputs before the initial measurement.
Keep later updates tied to their actual triggers. Do not replace the observer
with polling, a `MutationObserver`, or an effect that runs after every render.

### Preserve intent across DOM updates

For chat scrolling, capture the reader's intent before changing content:
either follow the tail or preserve a message anchor and its viewport offset.
The data and render-window projection must include the required anchor. Once
the corresponding DOM update is committed, execute the matching restore or
follow-tail command.

A command returning or an animation frame running does not prove that React
has committed the required DOM. Use the actual completion boundary. A commit
acknowledgement fulfills an action already requested by a command; rendering
must not invent a new action. Do not add hidden elements or change ref keys
merely to trigger measurement on every render.

Do not fall back to the bottom because the expected anchor is not mounted yet.
Resolve the render ordering or target availability explicitly. Cleanup must
not read a collapsing DOM tree and overwrite the saved reading position.

## Keep Asynchronous Content Geometrically Stable

Choose the card's geometry before loading finishes. Keep the same outer DOM
frame mounted through loading, ready, refreshing, error, and retry states;
replace only its contents. The persistent frame itself must carry the geometry.
An unsized wrapper around a replaceable sized child can still collapse.

Reserve the space needed by asynchronous media and action slots. Matching the
height before and after a replacement is insufficient if removing the old
element temporarily shrinks the transcript. Fix the card structure instead of
adding scroll compensation. Follow the detailed contract in
[Fixed Height and Stable Layout](./chat-cards.md#fixed-height-and-stable-layout).

## Derive the UI from State

Keep domain information in ccstate and derive presentation with `computed`.
For example, a conversation locator's sampled turns, labels, and tick ordering
come from the visible user-turn projection, not from scanning rendered cards.
Pointer commands update pointer state; computed values produce the rail's
presentation.

When an action needs DOM geometry, register the element through a stable
`onRef`, read only the required measurements in the owning command, and publish
only the minimal state needed by consumers. Do not maintain a second mutable
DOM-derived model or let imperative code and React both write the same visual
property.

Do not add continuous measurement without a required behavior. In particular,
the locator must not measure the transcript on every streaming update. Keeping
the chat pinned to the tail and deriving the locator are separate concerns with
different inputs.

## Preserve ccstate Ownership

- Define commands and scheduling wrappers in the owning signal graph, outside
  React render and command execution.
- Use one stable `onRef` owner for a container. It can invoke multiple attach
  commands while preserving a single mount lifetime and cleanup return.
- Pass the caller's `AbortSignal` as the final positional command argument.
  Do not store it in a measurement runtime object or fetch another scope's
  signal inside a command.
- A callback registered at an event boundary can capture that boundary's
  signal and pass it to the command. The signal belongs to the resource's
  lifetime, not to the duration of the setup command call. Use the native
  `addEventListener` signal option for listener cleanup.
- Keep scheduling flags in ccstate and update them through `set`. Do not mutate
  fields such as `runtime.resizeScheduled` behind ccstate's back.
- Coalesce high-frequency events only when needed, using the existing
  [command scheduling primitives](../.claude/skills/ccstate/references/lifecycle.md#debounced-and-throttled-commands).
  Do not share a scheduler across unrelated lifecycle signals. Cancel pending
  work when its owner ends.

## Review and Verification

For each use, identify the behavior it serves, every source of relevant change,
the owning command, and the exact DOM completion boundary. Select the CSS,
stable-layout, computed, or explicit-command replacement before changing code.
Simplify or remove unnecessary behavior instead of preserving its machinery.

Verify the observable contract for the affected surface: following the tail,
preserving a reading anchor during updates and history prepend, editor and
sidebar resizing, stable asynchronous card transitions, and cancellation on
unmount. Cover the applicable paths rather than asserting that a mocked
observer callback ran. Documentation and symmetric cleanup alone do not prove
that the intended trigger reaches the correct command.
