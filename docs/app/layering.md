# UI layering

Decide what covers what and which controls remain usable before assigning
`z-index`. These recommendations build on Web mechanisms and established
component practices. Specific components and numbers are project conventions;
see [stacking ownership](styles.md#stacking-ownership). Centralized layer tokens,
such as Material UI's scale, are also a valid design-system choice.

## Principles

- Treat positioning, clipping, and stacking as separate constraints. A larger
  z-index cannot escape an ancestor's stacking context or remove clipping;
  transformed ancestors can also confine fixed-positioned descendants.
- Prefer normal layout and paint order. When overlap needs a local boundary,
  include all participating controls in that host. `isolate` creates a stacking
  context without clipping; `relative` alone does not. Do not isolate every wrapper.
- Reuse shared primitives for floating surfaces. A portal only relocates DOM;
  it does not guarantee topmost painting. The primitive supplies positioning,
  focus, dismissal, and applicable scroll locking.
- Keep visual and input behavior aligned. Neither `opacity: 0` nor
  `pointer-events: none` removes keyboard focusability. Use the primitive's hidden
  state, native disabled behavior, or an appropriate inert region when needed.

## Choose the composition

| Scenario                          | Recommended composition                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Page, form, decoration            | Normal flow, Flex/Grid, and pointer-transparent decoration; ordinary buttons need no priority.                                |
| Image or card controls            | Positioned local host; add isolation and local ordering only when needed.                                                     |
| Whole-card action                 | Primary and secondary controls are siblings in one local host; never nest interactive controls.                               |
| Sticky header or frozen column    | One intended scrollport, sticky offsets, opaque backgrounds, and higher local priority at the row/column intersection.        |
| Save bar or footer                | Layout footer or scrollport sticky placement first; viewport-fixed bars need safe-area handling and content clearance.        |
| Menu, popover, select, tooltip    | Shared `@okouai/ui` primitive owns placement and interaction; do not raise the trigger.                                       |
| Dialog, sheet, nested popup       | Preserve primitive nesting, backdrop order, focus containment, dismissal, and scroll locking.                                 |
| App fullscreen                    | Shared `FullscreenPanel` in a suitable shell host; preserve content identity and reading position.                            |
| Native fullscreen                 | Ordinary overlays need a host inside the fullscreen element, using a supported API such as `DialogContent.portalContainer`.   |
| Loading cover, drag shield, toast | Keep coverage local unless global behavior is intended; use the shared toast service and clean up shields on every exit path. |

Native `showModal()` dialogs and shown popovers use the browser's top layer,
separately from ordinary DOM stacking; popovers are non-modal. For fullscreen
host placement and state-preservation limits, see
[floating layers](styles.md#floating-layers-and-portal-ownership).

## Examples

Labels below represent localized strings; numbers and dimensions are illustrative.

### Card with secondary actions

Keep all actions and the interactive footer in one local host. Prefer an explicit
link/button when text must remain selectable or the card has several destinations.
This example uses a button for an action; use a link for navigation.

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

The raised secondary wrapper covers only its controls, so empty space still
reaches the primary action. Z-index does not fix event bubbling.

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

The header and rows share horizontal scrolling. An intervening overflow ancestor
can change where sticky attaches. Match scroll padding to the actual header
height, including wrapping and zoom, so focused row actions stay visible.

### Menu inside a surface

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

Inside a dialog, preserve the library's logical nesting and supported portal
structure. Ordinary dismissal keeps default focus return. Opening another dialog
needs an intentional initial focus and a valid return target if the menu item
unmounts; do not suppress focus restoration or add delayed focus calls to hide a race.

## Verify behavior

- Check actual overlap and clicks, including transparent wrapper areas; class
  names and computed z-index alone cannot establish paint or hit order.
- Check keyboard controls, visible focus, Escape, and focus return. Modals keep
  focus inside and make background interaction unavailable. A visible toast does
  not automatically make its actions appropriate during a modal.
- Exercise relevant narrow/short viewports, wrapping, zoom, scrolling, safe areas,
  keyboard-open states, and fullscreen. iOS PWA behavior needs that environment.
- Repeat open, close, and cancel: release scroll locks, shields, and listeners;
  preserve content state and reading position across fullscreen transitions.

Add focused browser regressions for fixes and keep acceptance evidence in the PR.

## References

- MDN: [stacking contexts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Positioned_layout/Stacking_context), [positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position), [top layer](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer).
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- [React portals](https://react.dev/reference/react-dom/createPortal).
- [Base UI portal setup](https://base-ui.com/react/overview/quick-start#portals).
- [Material UI z-index scale](https://mui.com/material-ui/customization/z-index/).
