# ResizeObserver: Orchestrate Where the Change Happens

**Do not use `ResizeObserver` in Platform or `@okouai/ui`.** Lint reports every
reference as an error, including `window.ResizeObserver` and
`globalThis.ResizeObserver`, and links to this guide. No exception is approved,
so do not suppress the rule. If a change seems to need an observer, the cause of
the size change has not been found yet.

A size change is a rendering result. Reacting to it is a rendering side effect.
Continue the orchestration in the command that caused the change. Do not use a
subscription that waits for the render to report back.

This guide complements [effects and commands](../react.md#effects-and-ownership),
[ccstate lifecycle ownership](../../.claude/skills/ccstate/SKILL.md),
[styles](styles.md), and [stable chat cards](../chat.md#fixed-height-and-stable-layout).
For horizontal shelves and filter/category rows, see the concrete
[rail geometry and content-commit contract](rail-travel.md).

## Why the Observer Is Banned

Something writes state: a command, or a native browser event. React commits,
the browser lays out, and only then does `ResizeObserver` fire. If the
application continues its work from that notification, the operation's
follow-up becomes a side effect of rendering that operation's result.

It is also publish/subscribe through the layout engine. The command that changed
the layout does not know who depends on the change, and the subscriber does not
know what changed. The command knew the cause exactly when it ran; the
subscriber has to rediscover it from geometry.

That indirection has concrete costs:

- **Hidden dependencies.** A command does not show what it eventually
  triggers. A cause that only the observer happened to cover has no owner. For
  example, when an observer is the only thing remeasuring a list, removing it
  reveals every sibling change that never told the list it moved.
- **Completion that cannot be awaited.** The command returns before its
  consequences run. Its caller, loadable, and tests cannot wait for them, and
  cancellation does not reach them.
- **Lost transitions.** A notification carries only the latest size. A
  temporary collapse can move the scroll position even when the final size
  equals the previous one. An equal-sized DOM replacement invalidates stored
  nodes without any notification, and `display: contents` elements measure zero.
- **Feedback loops.** A callback that changes layout notifies itself again.
- **Duplicated layout rules.** A breakpoint measured in TypeScript repeats a
  rule that CSS already owns.
- **Tests aimed at the wrong side.** Tests stub the observer and fire its
  callback instead of performing the user-visible cause.

### Substitutes have the same problem

Deleting the constructor is not the fix. These keep the rendering-side-effect
design and are equally out of bounds:

- A custom DOM event, callback registry, or "layout changed" state that
  consumers subscribe to.
- A `MutationObserver`, or an effect or ref callback that measures after every
  render.
- Polling, timers, or `requestAnimationFrame` loops that sample geometry.
- Hidden elements or changed ref keys whose only purpose is to force a
  remeasure.

Correct `disconnect()` cleanup, a stable ref, or observing only the viewport
does not change the design either.

## Continue Orchestration in the Command

Find the operation that changes the content or the space around it. In that
command, after the state write, call the command that does the follow-up work
and await it with the caller's `AbortSignal`. The follow-up is now part of the
operation.

```ts
// signals/chat-page/chat-list-layout.ts: the consumer exposes a command.
export const refreshChatListLayout$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const frame = createDeferredPromise<void>(signal);
    animationFrame(
      () => {
        frame.resolve();
      },
      { signal },
    );
    await frame.promise;
    signal.throwIfAborted();
    set(threeColumnSidebarChatThreadScrollSignals.measureViewport$);
    set(get(pwaChatThreadScrollSignals$).measureViewport$);
  },
);

// signals/instatus-status.ts: the cause awaits it.
export const dismissInstatusIssue$ = command(
  async ({ get, set }, issueId: string, signal: AbortSignal) => {
    const nextDismissedIssueIds = new Set(get(dismissedIssueIds$));
    nextDismissedIssueIds.add(issueId);
    set(
      setDismissedIssueIdsRaw$,
      JSON.stringify(Array.from(nextDismissedIssueIds)),
    );
    // Mobile notices sit above the chat list.
    await set(refreshChatListLayout$, signal);
  },
);
```

What this buys:

- **A direct call, not a channel.** The consumer exposes a command such as
  `measureViewport$` or `syncLayout$`, and the cause calls it. No event,
  registry, or subscription sits in between.
- **The callers are the list of causes.** Searching for `refreshChatListLayout$`
  lists everything that can change the chat list's height. Something new beside
  the list adds one call in its own command. A missing call is a visible bug at
  the source, not a silent dependency.
- **Awaited under the caller's signal.** The operation's caller, its loadable,
  and its tests wait for the follow-up, and cancellation reaches it.
- **The cause names one follow-up.** The follow-up command decides which
  consumers are mounted. An unmounted consumer has nothing to read.

### Wait for the DOM that the work depends on

A command returning does not mean React has committed. Choose the boundary by
what the follow-up needs:

- A plain re-measure of a box can wait one animation frame under the caller's
  signal, as `refreshChatListLayout$` does.
- Scroll restoration, focus handoffs, and anything else that targets exact
  committed nodes establish the required DOM boundary in the owning command
  before using those nodes. Rendering must not invent a new action.
- An initial measurement waits for its inputs, such as the main stylesheet.
  Otherwise the first read sees unstyled geometry.

### Use the owner that outlives the change

Pass the caller's signal. When the cause is an element leaving, its own signal
has already aborted by the time the follow-up runs. Hand the follow-up to the
owner that outlives the element, as `refreshSidebarChatThreadLayoutOnRef$` does
with the root signal for app-shell elements.

### Causes that belong to the browser

Some causes are not application commands. Listen to the native event at that
source and bind the listener to its owner with the `signal` option:

| Cause                                         | Source                                             |
| --------------------------------------------- | -------------------------------------------------- |
| Window or mobile visual viewport resize       | `window` and `visualViewport` `resize`             |
| Display density change                        | `matchMedia("(resolution: …dppx)")` `change`       |
| Reading position                              | The scroll container's `scroll`                    |
| A CSS transition that changes usable space    | The width owner's `transitionend` and cancellation |
| Web font completion                           | The font loading promise or `document.fonts` event |
| Editor content, including programmatic drafts | The editor's document transaction                  |

These events are causes, not consequences. Do not use them as a general
"something changed" signal for application changes that already have a command.

## Choose the Replacement

Before changing code, name what the observer serves, then pick the replacement:

| The observer was used to                                       | Replace it with                                                                           | Example                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Choose a layout branch, wrap, truncate, or scale from its size | CSS: container queries and units, flex wrap, `min()`, registered properties, `visibility` | The presentation preview scales a fixed 1920 × 1080 canvas with container units; the composer uses `composer-wide` |
| Recompute after an application change of space or content      | The source command calls the follow-up command                                            | `refreshChatListLayout$`; a sidebar `LayoutPanel` commit calls the browser and image canvas `syncLayout$`          |
| Track viewport size or density                                 | The native events above                                                                   | `signals/browser/display.ts`                                                                                       |
| Use a number at a moment of user intent                        | Sample once at that input                                                                 | Clipped titles derive overflow in CSS and sample only the reveal duration on pointer or keyboard intent            |
| Follow a scroll track's content extent                         | Read at the matching content commit, keyed by a semantic revision                         | [Rail geometry](rail-travel.md)                                                                                    |
| Compensate for asynchronous content changing size              | Stable geometry, so nothing changes                                                       | [Fixed height and stable layout](../chat.md#fixed-height-and-stable-layout)                                        |
| Reconstruct data that already exists in state                  | `computed` over ccstate                                                                   | The browser tab strip's visible prefix; conversation locator ticks                                                 |

CSS being unable to express the entire behavior is not a reason to observe. The
measurement can still belong to an explicit command.

### Use CSS for layout

Use container queries for controls whose layout depends on their containing
panel, and natural flex wrapping when controls run out of room. Keep each
layout's breakpoint rule in one place instead of duplicating it in CSS and
TypeScript.

For the composer, follow the existing `composer-wide` variant described in
[the styles guide](styles.md#the-composers-width). Do not introduce width
state to reproduce that rule.

## Preserve Intent Across DOM Updates

For chat scrolling, capture the reader's intent before changing content:
either follow the tail or preserve a message anchor and its viewport offset.
The data and render-window projection must include the required anchor. Once
the corresponding DOM update is committed, execute the matching restore or
follow-tail command.

| Change                                                     | Deterministic trigger                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Message append, optimistic replacement, or history prepend | The command applying the event or history change, coordinated with its DOM commit |
| Sidebar drag, panel visibility, or section expansion       | The command owning the change, coordinated with the affected DOM update           |

Do not add hidden elements or change ref keys merely to trigger measurement on
every render. Do not fall back to the bottom because the expected anchor is not
mounted yet. Resolve the render ordering or target availability explicitly.
Cleanup must not read a collapsing DOM tree and overwrite the saved reading
position.

## Keep Asynchronous Content Geometrically Stable

Choose the card's geometry before loading finishes. Keep the same outer DOM
frame mounted through loading, ready, refreshing, error, and retry states;
replace only its contents. The persistent frame itself must carry the geometry.
An unsized wrapper around a replaceable sized child can still collapse.

Reserve the space needed by asynchronous media and action slots. Matching the
height before and after a replacement is insufficient if removing the old
element temporarily shrinks the transcript. Fix the card structure instead of
adding scroll compensation. Follow the detailed contract in
[Fixed Height and Stable Layout](../chat.md#fixed-height-and-stable-layout).

The same applies to rows that appear inside a measured surface: an operation
error that renders as an overlay does not change the surface's box, so nothing
needs to remeasure.

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

### Coordinate geometry and destination commits

Separate CSS width distribution from any data projection that needs a numeric
space budget. Measure a stable container that does not change identity when an
overflow control appears, reserve that control's space once, and treat unknown
or zero geometry as unavailable space rather than an infinite budget.

When multiple layout owners can animate, establish a conservative budget before
the moving layout is painted. A lower-only transaction limit must survive
interruptions and newly moving siblings. Reconcile the current owners and their
actual width/flex-basis transitions on run, end, and cancel; one terminal event
does not prove that all owners have settled. Release the limit only at that
shared completion boundary, not after a guessed duration or continuous sampling.

Direct manipulation must disable interpolation on every affected width owner,
including an owner remounted during the gesture. Explicit `transition-none` is
important: removing a transition-property utility while retaining a nonzero
duration can leave CSS's default `all` active. Keep discrete button animations
separate, and do not animate passive flex children as independent width owners.
When taking over an existing animation, preserve its displayed geometry before
cancelling it, while respecting the layout's minimum constraints.

A final gesture sample must reach the DOM before direct-manipulation ownership
is released or persisted. Otherwise React can batch that sample with restored
button-animation styles. Use a discrete synchronous completion boundary when
that ordering is required, not a per-move render scheduler. Cancellation, blur,
and unmount release the resource without applying a later terminal sample.

Deduplicate acknowledgements only when the committed elements, domain
identities, relevant containers, and semantic geometry keys are identical.
Reset the record with its DOM owner; never let it swallow mount, navigation, or
a distinct commit, or delay newer geometry behind an earlier asynchronous
restore. Native viewport and actual geometry-owner transition events still
refresh motion independently. Unrelated content and scroll owners retain their
own restoration lifetimes.

Focus handoffs have a DOM mount lifetime independent of a remote connection.
Record user intent as an exact request and consume it once at the corresponding
enabled destination commit. Use stable callbacks and semantic keys, not render
counters or fresh-per-render requests. A remote operation receipt is not a DOM commit. Revalidate mount,
authority, selection, destination availability, and retained intent before
focusing; later user input supersedes a pending handoff.

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
  [command scheduling primitives](../../.claude/skills/ccstate/references/lifecycle.md#debounced-and-throttled-commands).
  Do not share a scheduler across unrelated lifecycle signals. Cancel pending
  work when its owner ends.

## Review and Verification

For a layout-dependent change, list every source of relevant change, the
command that owns each one, and the exact DOM completion boundary. Each source
must reach its follow-up through a direct call. Select the CSS, stable-layout,
computed, or explicit-command replacement before changing code, and simplify or
remove behavior that no longer has a cause.

Test the cause, not a mechanism. Perform the user action or native event, such
as collapsing a section, dismissing a banner, or resizing the window, and
assert the visible result. Removing the source command's follow-up call should
make the test fail. Do not stub a size notification or drive a callback
directly.

Verify the observable contract for the affected surface: following the tail,
preserving a reading anchor during updates and history prepend, editor and
sidebar resizing, stable asynchronous card transitions, and cancellation on
unmount. Documentation and symmetric cleanup alone do not prove that the
intended trigger reaches the correct command.
