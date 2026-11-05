# Horizontal rail geometry

Composer shelves, document filter rows and connector category chips share the
rail boundary contract. This is separate from the task-chip/More overflow row.
The CSS path requires Safari 16+; there is no Observer fallback for older Safari.
Other browser support still requires the product's browser acceptance checks.

## Three inputs, three owners

| Input              | Owner                           | Update boundary                                                                                        |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Viewport width `W` | CSS inline-size query container | `round(nearest, 100cqw, 1px)` continuously follows layout, including sidebar transitions               |
| Content extent `C` | Rendered content projection     | Mount, matching semantic content commit, font completion/error, or native browser viewport/zoom resize |
| Actual offset `S`  | Browser scrolling               | Passive native `scroll`; also read when a content measurement can cause clamping/resnapping            |

A root is a padding/border-free `container-type: inline-size` box with a definite
external width. Its direct `data-rail` child is the scrollport and also has no
horizontal padding/border. Put horizontal gutters on the intrinsic
`data-rail-track`, whose `scrollWidth` includes them. Do not introduce another
inline-size query container between the root and its scrollport/pagers.

`C` is the actual max-content track's integer `scrollWidth`, not the viewport's
`scrollWidth` (which is at least its client width). Do not reconstruct `C` by
multiplying the nominal frame width and gap: per-item used-length quantization
can accumulate in a large catalog with fractional spacing/zoom. Fixed frames
still avoid remeasurement for changed titles, covers or media metadata.

Browser viewport resize is an explicit external content-metric boundary, not a
JavaScript owner for `W`. It covers browser zoom/used-unit rounding changes.
A local panel transition does not dispatch this event and does not need a
transition-end repair or JavaScript frame sampling. Font completion/error is a
separate, mount-owned resource boundary for intrinsic text metrics.

## Explicit content requests and DOM receipts

The view that projects a row supplies `RailViewport` with its semantic geometry
revision. The app adapter adds locale; the shared UI primitive writes that request
on the scrollport and returns the committed element and exact requested revision
from a dependency-scoped layout effect. `commitRailContent$` accepts only the
matching mounted DOM revision and ignores duplicate acknowledgements. This is not
an effect that measures every render. React lifecycle hooks stay in the UI
primitive; application commands own all geometry and native-event resources.

Current content owners are:

- `ComposerRail`: the actual rendered item count and the frame width. Import
  entries and retained/confirmed custom-template projections are already in that
  array; a pending response cannot acknowledge a future item count.
- `TemplateFilterPillRow`: the rendered pill identities, labels and order.
- `DirectoryCategoryChips`: translated All label, rendered section identities,
  labels and displayed counts, including Remote Access availability.

Selection/callback/ReactNode identity is not a geometry revision. Current
selected-state styles do not change text metrics. If a future selection style,
responsive label, gap, badge or layout option changes intrinsic width, its owner
must extend the geometry request or provide its explicit external completion
boundary. Do not silently rely on an unrelated rerender or panel animation.

The registry belongs to the ccstate Store and is keyed by physical scrollport,
not business rail name. A stable `onRef` owns scroll/font/viewport listeners and
DOM registration. A mount identity guards replacement owners of the same element.
Abort removes those listeners and only unregisters its own mount; cleanup performs
no measurement. No content request waits on a timer or an
animation frame, and there are no production DOM observers or measurement loops.

## Boundaries and interaction

The legacy strict predicates remain `S > 1` for back and `C - W - S > 1` for
forward, with a 1 CSS px tolerance. Back is not additionally gated on overflow.
`sign()` plus `clamp()` selects exact hidden/visible endpoints. Both pager buttons
stay mounted; a finite, permanently paused CSS animation selects `visibility`,
not opacity alone. This endpoint selector must remain enabled under reduced
motion so unavailable controls stay out of pointer/Tab navigation.

Masks use those same inputs: 56px for composer/filter rails and 48px for category
chips, with prefixed and unprefixed declarations. Keyboard-visible focus cancels
both masks. Native scrolling, snapping and reduced-motion behavior remain with
the scrollport. Paging reads `clientWidth` at click time and requests
`max(clientWidth - 64, 1)` in the chosen direction; the browser owns the actual
smooth-scroll/snap endpoint. Pagers target only their root's direct rail child.

## Acceptance boundaries

Page tests can cover public filtering, keyboard interaction, paging and instance
isolation with browser geometry adapters. Happy DOM cannot prove computed CSS
visibility, hit testing, masks, container units, smooth scrolling or snapping.

Use a layout-capable browser for fitting/overflow transitions, 1px and fractional
boundaries, actual snap/pager endpoints, a scrolled catalog shrinking to fit,
retained catalog refresh, translated/count changes, changed font metrics,
zero-width/reveal, simultaneous rails, zoom and 240ms sidebar transitions.
Check reduced motion, hidden focused pagers and mask removal as well. Real
Safari/iOS Safari and VoiceOver acceptance is separate from Chromium component
probes or compatibility tables. Removing Observers is not evidence of a measured
performance improvement or complete behavioral equivalence.
