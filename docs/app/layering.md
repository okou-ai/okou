# UI layering: project practices grounded in Web standards

Design which surfaces cover which content, and which interactions remain
available, before choosing a host or a `z-index`. A correct layer has a clear
scope, suitable DOM placement, and matching visual, pointer, and keyboard
behavior. The owning component encapsulates that relationship so callers can
select behavior instead of coordinating numbers.

## Scope and authority

This guide distinguishes three kinds of guidance:

- **Web platform mechanisms:** stacking contexts, clipping, positioning, and
  the browser's top layer determine what CSS can do. See [MDN stacking contexts],
  [MDN positioning], and [MDN top layer].
- **Established interaction and implementation practices:** the [WAI-ARIA modal
  dialog pattern] recommends focus placement, contained tab navigation,
  dismissal, and focus return. [React portals] and [Base UI portal setup]
  describe implementation mechanisms. These are not a requirement that every
  application use React, a portal, or this project's components.
- **Project conventions:** shared primitives own floating layers, the app root
  isolates app-local content, and necessary local ordering uses literal
  Tailwind utilities. The binding project rules live in
  [stacking ownership](styles.md#stacking-ownership). Specific numbers, component
  names, and the restriction on business-owned portals are project choices.

A centralized z-index token scale is also a valid design-system choice;
[Material UI's z-index scale] is an established example. This project currently
uses context ownership and literal utilities instead. Neither approach lets an
ordinary descendant escape its ancestor's stacking context, and neither proves
that the resulting UI behaves correctly.

## Design the relationship first

1. Identify the surface's scope: one card, one scrollport, a dialog, the app
   shell, or a native fullscreen element. Name the siblings it should cover and
   the controls that should remain usable.
2. Inspect three independent constraints: positioning, overflow clipping, and
   stacking contexts. `relative` alone does not create a stacking context;
   `isolate` does, without clipping content. `fixed` creates a context but does
   not escape an ancestor's context. Transformed ancestors can also change a
   fixed element's containing block. Raising z-index does not remove clipping.
3. Prefer normal flow, Flex/Grid, or ordinary paint order when no special
   overlap is needed. For overlap, use the existing shared component or a host
   that contains all participants in the intended local relationship. Add
   isolation deliberately, not to every layout wrapper.
4. Keep positioning, ordering, focus, dismissal, and cleanup with their owning
   primitive or layout. A React portal relocates DOM; it does not by itself
   provide topmost painting, modality, collision avoidance, or focus management.

## Common scenarios

| Scenario                                  | Intended relationship                                                                       | Recommended composition                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary page, form, or decoration        | Content follows layout; decoration does not intercept controls                              | Normal flow, Flex/Grid, backgrounds, and pointer-transparent decoration; no added priority for ordinary buttons.                                                            |
| Image or card controls                    | Controls cover only their own media/content                                                 | A positioned local host; ordinary paint order first, with explicit local isolation and ordering only when needed.                                                           |
| Whole-card action with secondary controls | Primary action covers the card; secondary actions stay independently usable                 | Sibling interactive elements within the complete local host; never nest buttons or links inside another interactive control.                                                |
| Sticky header and frozen column           | Headers cover scrolling rows; the corner covers both sticky axes                            | One intended scrollport, sticky offsets, opaque surfaces, and local ordering for row/column intersections.                                                                  |
| Save bar or page footer                   | Actions remain available within their owning surface                                        | Normal layout footer or scrollport sticky placement; use viewport-fixed placement only for a viewport-owned bar, with content clearance and safe-area handling.             |
| Menu, popover, select, or tooltip         | Floating content covers its owning surface without clipping                                 | Existing shared primitive for portal placement, positioning, collision handling, and the interaction pattern appropriate to that component. Do not raise the trigger.       |
| Dialog, sheet, or nested popup            | Popup covers its backdrop; nested content remains usable within the parent's modal boundary | Preserve shared primitive nesting and its focus, outside-press, dismissal, and scroll-lock ownership.                                                                       |
| App fullscreen                            | The panel covers the app regions it owns while shared floating layers remain usable         | Shared `FullscreenPanel`, a suitable shell host, and stable content identity across transitions.                                                                            |
| Browser native fullscreen                 | Viewer controls and floating content remain visible and usable in fullscreen                | An ordinary DOM overlay uses a host inside the fullscreen element; native top-layer surfaces require their own ordering and interaction checks.                             |
| Loading cover, drag shield, or toast      | Coverage, input blocking, and lifetime match the operation                                  | Local covers stay local; global notices use the shared toast service. Define which input is blocked and remove shields/listeners on every completion and cancellation path. |

## Recommended compositions

The snippets illustrate structure. Imports, business data, and localization are
omitted; labels stand for localized strings. Numbers and dimensions are examples,
not a universal scale or permission to add priority at arbitrary call sites.

### Local card overlap

Use a whole-card action only when the interaction calls for it. Cards containing
selectable text, multiple destinations, or rich controls may work better with an
explicit title link or action button. Navigation uses an anchor or Router Link;
the example below performs an action.

```tsx
<article className="relative isolate rounded-lg">
  {content}
  <button
    type="button"
    aria-label={openLabel}
    onClick={onOpen}
    className="absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
  />
  <div className="relative z-20 w-fit">{secondaryAction}</div>
</article>
```

Here, `10` and `20` compare only the card's participants. Keep the primary
action, secondary controls, and any interactive footer in that complete local
host. Isolating only the inner media surface can leave the footer in a different
context. Keep the raised secondary wrapper's hit area tight; a full-card
transparent wrapper can swallow clicks intended for the primary action.

Isolation is useful when the component needs this boundary. Reuse an existing
deliberate context when appropriate rather than adding another automatically.
Neither isolation nor a higher z-index fixes event bubbling or invalid nested
interactive HTML. Match the intended keyboard order as well as the paint order.

### Sticky table header

```tsx
<div className="isolate max-h-96 overflow-auto scroll-pt-12">
  <table className="w-full min-w-[36rem] border-separate border-spacing-0">
    <caption className="sr-only">{tableLabel}</caption>
    <thead>
      <tr>
        <th scope="col" className="sticky top-0 z-10 h-12 bg-card text-left">
          {columnLabel}
        </th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
</div>
```

The height constraint makes this wrapper the intended scrollport; the table
and its header move together horizontally. An intervening overflow ancestor
can change where sticky attaches, even if that ancestor does not visibly scroll.
The opaque background prevents rows showing through the header. Local isolation
keeps the header's priority from competing with neighboring page controls.

Match scroll padding to the actual header height, including wrapping and zoom;
`h-12` and `scroll-pt-12` only illustrate a header that fits that height. For a
frozen column, give the header/column intersection priority over both within
this same context. Preserve table semantics and check that keyboard-focused
rows and actions remain visible below the sticky region.

### Anchored menu

```tsx
<DropdownMenu>
  <DropdownMenuTrigger render={<Button type="button" variant="ghost" />}>
    {moreLabel}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={onCopy}>{copyLabel}</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Use the shared components from `@okouai/ui`. The trigger needs no stacking
utility. The primitive owns placement and keyboard behavior. When this menu is
inside a dialog, preserve the library's logical nesting and supported portal
structure so the menu remains inside the dialog's interaction ownership.

Ordinary dismissal retains default focus return. If a menu action opens a
confirmation dialog, give the new dialog an intentional initial focus and a
valid return destination if the original menu item unmounts. Avoid unconditional
`blur()`, focus-return suppression, or delayed focus calls to hide a handoff race.
A tooltip is not a substitute for an interactive menu or popover.

### Action bars and modal surfaces

Prefer a layout footer when actions can stay outside the scrolling content.
Use sticky placement when they should follow a particular scrollport. The
existing `UnsavedBar` exposes `pinning="scrollport"` for that relationship;
its viewport mode is a different placement contract, not just a larger index.

For a bar whose positioning wrapper spans empty space, keep that wrapper
`pointer-events-none` and the visible controls `pointer-events-auto`. Reserve
enough content clearance and scroll padding that the bar does not hide the last
row or its focused action. A modal backdrop intentionally blocks interaction
and must not adopt the same click-through treatment.

Modal dialogs move focus inside, keep their tab sequence inside, and make the
background unavailable to interaction. Follow the shared primitive's dismissal
behavior and the [WAI-ARIA modal dialog pattern], including its exceptions for
returning focus to the invoking element when the workflow or DOM has changed.
Backdrop painting and pointer interception alone do not establish modality.

### Fullscreen and the browser top layer

CSS app fullscreen and `requestFullscreen()` are different mechanisms. Use the
shared `FullscreenPanel` for app fullscreen. Its shell host must actually cover
the intended app regions; `fixed inset-0` inside an unsuitable ancestor is not a
substitute. Its `relocate={false}` option requires a suitable existing shell
host. See [floating layers and portal ownership](styles.md#floating-layers-and-portal-ownership).

For native fullscreen, ordinary DOM overlays outside the fullscreen element
cannot be raised above it by increasing z-index. Use a supported container API,
such as `DialogContent.portalContainer`, to place those overlays inside the
fullscreen element, and verify both clipping and nested interactions there.
Do not assume every wrapper exposes that prop.

Native dialogs opened with `showModal()` and shown popovers enter the browser's
top layer independently of ordinary document stacking. Their ordering and
behavior must be considered separately; a shown popover is non-modal. The
recommendation to host an ordinary overlay inside fullscreen is not a universal
rule for all native top-layer elements.

Keep the same content subtree and portal container across app fullscreen
transitions. [React portals] recreate their content when the target DOM node
changes. The shared primitive preserves a stable container; its native
`moveBefore` path preserves embedded state, while its `appendChild` fallback
restores scroll but may reload frames or media. Verify a reading anchor when
text reflows: retaining the same `scrollTop` alone may show different content.

## Interaction and lifetime

- Pure decoration may be pointer-transparent. `pointer-events: none` does not
  remove keyboard focusability; use native disabled behavior or an appropriate
  inert region when interaction truly must be unavailable. Do not inert a host
  that also contains the active dialog.
- `opacity: 0` alone leaves an element in hit testing and keyboard navigation.
  Let the primitive manage the hidden/exit state, focus, and eventual unmount.
  Visual animation completion and dismissal cleanup must agree.
- A shared toast service owns notification placement. Showing notifications
  above dialogs is this app's policy, not a universal toast ordering rule.
  Check visibility separately from whether an action is allowed while a modal
  is open; do not make background actions operable merely by raising them.
- Loading and drag shields need defined pointer and keyboard behavior plus
  cleanup for success, failure, cancellation, navigation, and unmount. Close
  paths must release scroll locks and any listeners they own.

## Verify the relationship

For the affected scenario, verify observable behavior in the browser:

1. Open overlapping surfaces together and check actual painting: header over
   rows, popup over backdrop, nested popup over parent, and fullscreen over its
   intended app regions.
2. Click real controls at overlap boundaries and in transparent wrapper areas.
   Confirm which action runs; a screenshot cannot establish pointer hit order.
3. Use Tab, Shift+Tab, Escape, and the component's other keyboard controls.
   Check visible focus, modal containment, ordinary focus return, and explicit
   handoffs when one surface opens another.
4. Exercise relevant narrow/short viewports, zoom or wrapping, scrolling, safe
   areas, keyboard-open states, and fullscreen modes. Installed iOS PWA behavior
   needs evidence from that environment rather than a desktop approximation.
5. Repeat opening, closing, and cancelling; confirm scroll unlock, shield
   removal, preserved content state, and a stable reading position where needed.

Add focused browser regressions for behavior being fixed. Assertions about class
names or computed z-index alone cannot prove paint order, clipping, or hit
targets. Review the actual host, ancestor chain, and interaction ownership when
changing a layer or moving its component. Keep browser evidence for a particular
change in its PR or issue.

## References

- [MDN stacking contexts] for CSS stacking boundaries and atomic ordering.
- [MDN positioning] for containing blocks and sticky scroll ancestors.
- [MDN top layer] for fullscreen, modal dialogs, and shown popovers.
- [WAI-ARIA modal dialog pattern] for recommended modal interaction and focus rules.
- [React portals] for DOM placement, event propagation, and target identity.
- [Base UI portal setup] for the library's root-isolation integration guidance.
- [Material UI's z-index scale] for a centralized layer-token design.

[MDN stacking contexts]: https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Positioned_layout/Stacking_context
[MDN positioning]: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position
[MDN top layer]: https://developer.mozilla.org/en-US/docs/Glossary/Top_layer
[WAI-ARIA modal dialog pattern]: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
[React portals]: https://react.dev/reference/react-dom/createPortal
[Base UI portal setup]: https://base-ui.com/react/overview/quick-start#portals
[Material UI's z-index scale]: https://mui.com/material-ui/customization/z-index/
