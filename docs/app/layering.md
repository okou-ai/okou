# UI layering

Decide coverage and interaction before `z-index`. These recommendations apply Web
mechanisms to [project conventions](styles.md#stacking-ownership); component APIs
and numeric values are local choices. Centralized layer tokens are also valid.

## Principles

- Separate positioning, clipping, and stacking. Larger z-index cannot escape an
  ancestor's stacking context or clipping; transforms can confine fixed elements.
- Prefer layout and paint order. Use `isolate` only for deliberate local stacking
  contexts that contain all participating controls.
- Shared primitives own floating behavior. A portal only relocates DOM; it does
  not guarantee topmost painting, focus management, or modality.

## Choose by scenario

| Scenario                          | Recommended approach                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page, form, decoration            | Normal flow; decoration does not intercept input.                                                                                                                                                     |
| Image or card controls            | Local positioning; add isolation and ordering only when needed.                                                                                                                                       |
| Whole-card action                 | Sibling primary/secondary controls; prefer explicit links/buttons for selectable content. [Card example](../../turbo/apps/platform/src/views/okou-page/components/settings/connector-entry-card.tsx). |
| Sticky header or frozen column    | One scrollport, opaque headers; frozen corner above both axes. [Header example](../../turbo/apps/platform/src/views/okou-page/components/org-manage/org-invoices-tab.tsx).                            |
| Save bar or footer                | Layout footer or sticky first; fixed bars need safe areas and content clearance. [UnsavedBar](../../turbo/apps/platform/src/views/okou-page/unsaved-bar.tsx).                                         |
| Menu, popover, select, tooltip    | Shared primitives; do not raise the trigger. [DropdownMenu](../../turbo/packages/ui/src/components/ui/dropdown-menu.tsx).                                                                             |
| Dialog, sheet, nested popup       | Preserve nesting, focus, backdrop order, and dismissal. [Dialog](../../turbo/packages/ui/src/components/ui/dialog.tsx).                                                                               |
| App fullscreen                    | Suitable shell host and stable content identity. [FullscreenPanel](../../turbo/packages/ui/src/components/ui/fullscreen-panel.tsx).                                                                   |
| Native fullscreen                 | Ordinary overlays belong inside the fullscreen element, using supported APIs such as `DialogContent.portalContainer`.                                                                                 |
| Loading cover, drag shield, toast | Define coverage and input blocking; use the shared toast service and clean up on every exit.                                                                                                          |

Native modal dialogs and shown popovers use the browser's top layer; popovers
are non-modal. Fullscreen host and state-preservation details stay in the
[style guide](styles.md#floating-layers-and-portal-ownership).

## Verify

- Check actual overlap and click targets, including empty wrapper space.
  `opacity: 0` and `pointer-events: none` do not remove keyboard focusability.
- Check Tab, Escape, focus return, and explicit handoffs between surfaces;
  modal backgrounds must remain unavailable to interaction.
- Exercise scrolling, narrow/short viewports, zoom, safe areas, keyboard-open
  states, and fullscreen. Verify iOS PWA behavior in that environment.
- Repeat close/cancel: release locks, shields, and listeners; preserve content
  state and reading position. Add browser regressions for fixes.

## References

- MDN: [stacking contexts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Positioned_layout/Stacking_context), [positioning](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position), [top layer](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer).
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- [React portals](https://react.dev/reference/react-dom/createPortal).
- [Base UI portal setup](https://base-ui.com/react/overview/quick-start#portals).
- [Material UI z-index scale](https://mui.com/material-ui/customization/z-index/).
