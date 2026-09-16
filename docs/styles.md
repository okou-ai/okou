# App style guide

The App design system has one component-facing styling API: Tailwind utilities. Business components in `turbo/apps/platform` and shared components in `turbo/packages/ui` must compose utilities directly, normally through `className`, `cn()`, or `cva()`.

First-party CSS class selectors are not a second component API. New CSS modules, `<style>` elements, runtime stylesheet injection, and CSS-in-JS are subject to the same boundary because they otherwise bypass Tailwind and the token system.

## Final state

The final goal is zero first-party CSS class selectors for business styling, including all existing selectors. Preventing growth is an interim guardrail, not completion of this goal.

- Business and shared UI components use Tailwind utilities and semantic component variants. They neither define nor depend on first-party styling classes, including classes that wrap `@apply`.
- Existing first-party selectors, their class dependencies, and component-owned inline or injected styles are eliminated. The legacy baseline is empty; existing code is not a permanent exception.
- Runtime behavior and tests use semantic roles, accessible names, refs, `data-*` hooks, or documented component slots instead of querying styling classes.
- Remaining handwritten CSS is limited to centrally managed design variables and tokens, explicitly allowlisted global environment rules, and explicitly allowlisted third-party DOM adapters. These exceptions do not authorize business styling.
- Every environment or adapter exception has an exact scope, owner, rationale, and removal condition. Third-party entries also identify the upstream DOM owner; vendored stylesheets are pinned to their exact content hash. Directory-wide ignores and class-prefix exemptions are not allowed.
- The design system has a documented ownership chain from primitive variables to semantic tokens, Tailwind utilities, and component variants, including naming, theme mapping, introduction, change, deprecation, and review. Components reuse that contract instead of creating a parallel variable or token registry.
- Lint and agent instructions enforce the same boundary. Failures direct contributors to this guide and the underlying fix; business selectors cannot be authorized by disabling lint, expanding a baseline, or adding an allowlist entry.
- The final automated audit reports zero first-party selector declarations, zero business-component dependencies on legacy styling APIs, and only validated global-environment and third-party-DOM exceptions.

The current lint freezes legacy state while it still exists. Passing that check establishes compliance with the current guardrail; it does not establish that existing first-party selectors have been cleared. The complete goal is tracked in [#32402](https://github.com/vm0-ai/vm0/issues/32402).

## Sources of truth

| Concern                                         | Source of truth                                                                    | Consumer contract                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primitive and runtime theme values              | `turbo/packages/ui/src/styles/globals.css` under `:root` and `[data-theme="dark"]` | Referenced through semantic variables, not directly from components          |
| Tailwind design tokens                          | Shared `@theme` definitions in `turbo/packages/ui/src/styles/globals.css`          | Utilities such as `bg-background`, `text-muted-foreground`, and `rounded-lg` |
| App-only semantic tokens                        | `@theme` in `turbo/apps/platform/src/views/css/index.css`                          | Named utilities for an App domain concept; promote to UI when shared         |
| Component variants                              | TypeScript component APIs and `cva()` definitions                                  | A bounded set of semantic props and Tailwind utility combinations            |
| Global environment and generated DOM adaptation | `turbo/style-allowlist.json`                                                       | Infrastructure-only exception with exact selector or injection fingerprint   |

Token names describe meaning rather than a page or component. A reusable interaction state, surface, foreground, border, radius, or typography decision belongs in the shared token layer. A product-specific data visualization category may remain App-only until another product consumes it. Theme differences are assigned at the primitive/runtime variable layer; components continue to use the same semantic utility in both themes.

Components must not introduce local CSS variables as an alternate token registry. A runtime value that is genuinely computed by the component may use a narrowly named custom property as data, while its visual semantics still come from Tailwind utilities and registered tokens.

One hairline serves the whole product. `--default-border-width` in the shared `@theme` is 0.5px, and Tailwind's bare `border`, `border-t`, `border-x`, `divide-y`, and their siblings all read it, so a component asks for "a border" and the system decides how thick it is. Components must not hand-write a width: an arbitrary width such as `border-[0.7px]`, or a literal width inside a `style` prop, is a second registry for a decision this token already owns. `border-0` and the deliberate emphasis widths such as `border-2` stay available, because they express a different decision rather than a competing value for the same one.

This is a real hairline, not a rounding no-op. On a 2x display 0.5px paints one device pixel where 1px paints two, so every bare border carries half the ink it used to; layout is unaffected, because the used value is still rounded to whole pixels. Colour has to carry what the width no longer does, which is why `--border` sits one stop darker than the surface ramp's lightest step: `gray-200` was calibrated for a 1px line and stops reading on a near-white card at half the thickness.

A third token covers the case neither of those can. `--border` and `--divider` are both measured against the page canvas, and `--divider` is pinned to `gray-200` in every theme; the gradient color presets also keep `gray-200` for `--border`. The filled surfaces that carry their own rules are `gray-200` themselves, so under those presets a rule reading either neutral token resolves to its own background and disappears — the user message bubble's quote rule and its group divider were both painted in the bubble's fill, byte-identical, in all eight presets in both modes. `--border-on-fill` is one step off that fill rather than off the canvas. Use `border-border-on-fill` for a border or rule drawn on a filled surface, and keep `border-border` for one drawn on the canvas or a card. It equals `--border` in the neutral themes, so adopting it changes nothing there; moving `--border` itself would instead have restyled all 390 of its usages across 125 files, and the presets' `gray-200` already matches the neutral border weight against their lighter card.

Borders and rules are separate decisions with separate tokens. `--border` is for real borders, which follow `--default-border-width`. `--divider` is the lightest neutral rule — separators, `h-px` / `w-px` hairlines painted as backgrounds, and resting rail ticks. Those are sized explicitly, so they never lost thickness to the border hairline and must not inherit its compensating darkening. Use `bg-divider` for a painted rule and `border-border` for an actual border; do not reach for a raw ramp stop such as `border-gray-200` for either, because that bypasses both decisions.

Color-theme presets in the App stylesheet share their anchor and companion colors between picker swatches and workspace ambience. Daydream uses cool blue and violet, while Cotton sky uses pastel pink and blue. Each preset's hue and ring values keep semantic surfaces, selected states, and focus indicators aligned with that palette in Light/Dark.

When `GradientColorThemes` is enabled on the document, each preset's HSL primary value supplies both its anchor color and the shared `--primary` token. Primary actions, including portaled dialog buttons, immediately use that fill and the preset's contrast-checked `--primary-foreground` in Light/Dark. Hover and pressed fills blend the anchor toward its companion using the existing filled-state alpha tokens. Disabled buttons retain the shared opacity treatment. Removing the document's color-theme attributes restores the shared Amber primary tokens.

Auxiliary controls and previews revealed by hover or keyboard focus change
opacity immediately. Do not add opacity transitions to message actions,
sidebar controls, card overlays, or similar contextual affordances; temporary
compositing layers can cause nearby content to flicker in Safari. Preserve
their layout, focus visibility, touch behavior, and pointer-event rules. When
other properties still animate, name those properties instead of using
`transition-all`. This does not remove loading or popup lifecycle animations.

## Token and variant governance

New tokens must represent a reusable semantic decision, have a documented consumer contract, and define their light and dark theme behavior in the canonical stylesheet. Shared tokens and variants belong to `@okouai/ui`; App-only tokens belong to the App token layer. A new alias for one component's hard-coded values is not a token contract.

Token and variant changes are reviewed at their owning layer together with affected consumers and theme behavior. A rename or semantic change must update those consumers; deprecated names are removed when their consumers have migrated, rather than being copied into component-local registries. A change to ownership, naming, or theme mapping must update this guide in the same PR.

Large editable surfaces use `border-surface-focus` to emphasize their existing border on focus: neutral gray in light themes and muted amber in dark themes. Keep the border width constant across interaction states. A shadow-only focus overlay may fade through opacity, but must not duplicate the surface border or depend on a negative inset to align its edge. The chat composer uses the default `border` width for its surface and connector circles; intentional badge overlap remains independent of border geometry. `data-slot="chat-composer-card"` identifies the editable card for keyboard positioning and page tests.

The composer's focus overlay is `--okou-composer-focus-veil`. It is a runtime theme value, so it is owned at `:root` in the App stylesheet rather than inside the `.okou-app` scope: `signals/theme.ts` writes the theme attributes onto the document element, and document scope keeps the token available to any surface that later needs it, including portaled ones. Light carries a neutral veil, dark carries none, and the gradient themes tint it with the canonical state layer. Each override keys off `[data-theme="dark"]` and `[data-gradient-color-themes]` alone and wraps the theme test in `:where()`, so it stays at the specificity of the rule it refines and source order decides between them. Do not reach for the paired `.dark` class here: a class in the selector registers a new first-party class-selector declaration and fails the shrink-only baseline.

A focus overlay is also sized to the space its surface actually has. The composer sits 16px above the workspace pane's bottom edge, so the veil's offset and blur must bring its falloff back to the surface inside that gap. An overlay still painting when it meets a clipping ancestor or the pane edge ends in a visible straight seam instead of fading out, and the gap is not a place to absorb an arbitrarily wide shadow.

Standalone selectable controls use the shared `ToggleButton` and its required
`selected` prop. Its default `inline` layout keeps compact icon/text choices;
`layout="tile"` fills a grid cell with centered text and 12px horizontal / 10px
vertical padding for Agent profile Tone choices. It retains native button/ref behavior and owns `aria-pressed`,
the selected primary treatment, focus ring, and disabled appearance. The shared
`control-surface` and `control-border` colors map to the runtime gray-50 and
gray-400 ramps in both light and dark themes, including palette overrides.
`bg-state-hover-overlay` layers the existing hover state over an opaque fill.
The toggle variant keeps this overlay's unconditional `:hover` behavior for
touch compatibility; it preserves the existing media-aware text hover utility.
Migrate consumers individually and retain the legacy definition until its last
consumer is removed.

`Button` represents an action; `ToggleButton` represents a persistent pressed
state. Both render through the internal `ButtonBase` in `button-base.tsx`, which
owns the Base UI button primitive, ref forwarding, render/asChild composition,
native-title handling and optional tooltip. Their typography, radius and focus
styles also share one base definition. Dimensions, icon sizing, transitions and
disabled appearance remain owned by each styled control. `ToggleButton` keeps the
native button and `onClick` contract; it does not manage state or change group
keyboard behavior. Single-value settings keep a selection when the active
choice is activated again. Use the existing `SegmentControl` for a new radio
group that needs group-level keyboard navigation.

Both buttons keep `showTooltip` off by default. Enabling it requires an
`aria-label`, which also supplies the tooltip content; the native `title` is
removed to avoid duplicate hints. The shared tooltip supports disabled triggers
and preserves full-width tile layout. Visible labels and essential explanations
remain available without hovering.

### The composer card surface

`Card` from `@okouai/ui` takes `surface="composer"` for the composer card and the
two surfaces that sit in its place: the service-status notice and the shared
thread's claim prompt. The variant carries the fill, radius, border, shadow, the
focus border transition and the `after` veil layer; callers keep layout,
stacking and container context, which is why the composer still spells
`@container/composer z-10` itself. The `okou-composer` selector and its
consumers have been removed.

It is a `cva` variant on the component rather than an exported class string,
because a class constant is not a component API: a caller can reorder it against
its own utilities, and nothing types which surfaces may take it. `surface`
defaults to `default`, so every existing `Card` is unchanged. The variant reads
the App's `--okou-card-shadow` and `--okou-composer-focus-veil` from the shared
package, the way `DialogContent` already reads `--okou-viewport-height`.

The two borrowed surfaces did change, on purpose. They had been pinned to an
earlier spelling of the composer that the composer itself no longer used, so
draining the selector meant choosing which one they follow. At rest their border
moves one step — lighter in Light, darker in Dark — and the measured difference
stays under 17/255 on a one-device-pixel line, because the retired `0.7px` and
the shared hairline both round to the same single device pixel at every scale
factor tested. On focus in Light the retired rule also drew a second ring
outside the card at `--gray-500`; the shared surface paints focus on the border
the card already has, for the reason the guide gives above. Dark focus keeps the
muted amber either way.

`--okou-composer-ring` and `--okou-composer-radius` are removed with the rule.
The ring had no consumer left once the extra layer was gone, and the radius is
`rounded-3xl`, which is the same 1.5rem. `--okou-composer-focus-veil` stays: the
shared surface still reads it, and it remains a `:root` runtime theme value for
the reason recorded above.

### Page surfaces

`surfaceVariants` from `@okouai/ui` owns the shared page-surface treatment. Use it on the existing native element, or pass its classes to `Card`; it does not add a wrapper or change button, form, link, scroll, or overflow semantics. Its `className` option composes layout utilities. `radius` is `standard` by default or `compact`; `interactive` opts a whole surface into the pointer hover overlay and defaults to `false`. A surface containing separate interactive children can keep the default treatment.

| Decision        | Shared token / utility                                    | Theme contract                                                                                       |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fill            | `bg-card`                                                 | Existing semantic card fill in each theme                                                            |
| Border          | `--color-surface-border`, `--border-width-surface`        | Gray 400 at the shared `--default-border-width` hairline; the browser rounds for its device scale    |
| Radius          | `rounded-surface`, `rounded-surface-compact`              | 1.25rem and a fixed 12px respectively in every theme                                                 |
| Elevation       | `shadow-surface` via `--surface-shadow`                   | Neutral lift in Light/Dark; the gradient theme uses the canonical state-layer hue with reduced alpha |
| Pointer overlay | `bg-state-hover-overlay`                                  | The shared interaction-state overlay painted above the opaque card fill                              |
| Transition      | `transition-[background-color] duration-150 ease-surface` | Background color only, 150ms, CSS `ease`                                                             |

The variant uses `border-(length:--border-width-surface)` so class merging recognizes the border width independently of its color. Shared `cn()` registers the custom radius and shadow scales with `tailwind-merge`, keeping composition with existing UI primitives consistent with Tailwind generation. Register new named scales there when the class merger cannot otherwise identify their property group.

The pointer overlay reuses the shared `bg-state-hover-overlay` token rather than declaring a surface-specific one, so one interaction-state decision keeps one owner. Like the choice variant, it applies through `[&:hover]` to preserve the existing touch-browser hover contract as well as pointer hover, and it does not replace the card fill with a translucent background. Radius, border, shadow, and transition decisions belong to this variant; use layout utilities for padding, size, alignment, and overflow.

Integration and connector tests scope controls through the documented `data-slot="integration-card"`, `data-slot="connector-card"`, `data-slot="badge"`, and `data-slot="sidebar-thread-title"` component boundaries. These slots carry no styles; tests must not locate surfaces through utility or legacy class names.

The `okou-card` selector and its consumers have been removed. This equivalent migration also removes background, border, shadow, and focus-ring overrides that the old unlayered selector had suppressed; activating those overrides would be a separate visual change. Existing `--okou-card-*` variables still consumed by other legacy components remain frozen until those components migrate; they are not a supported API for new surfaces.

### Inline badges

`Badge` from `@okouai/ui` owns the shared inline badge and tag treatment: role labels, status pills, version chips, and diagnostic key/value chips. It renders a `span`; pass `render={<code />}` for another host element. It adds no wrapper and takes no size or tone props.

| Decision    | Shared token / utility                        | Contract                                                                                  |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Fill        | `bg-gray-0`                                   | The neutral base of the gray scale in each theme                                          |
| Border      | `border`, `--color-surface-border`            | Gray 400 at the shared `--default-border-width` hairline                                  |
| Radius      | `rounded-md`                                  | One radius for every badge                                                                |
| Padding     | `px-2 py-0.5`                                 | One inset for every badge                                                                 |
| Line height | `leading-snug`                                | 1.375 of the badge's own font size, never an ancestor's                                   |
| Layout      | `inline-flex items-center gap-1 align-middle` | Icon and label share one row; `align-middle` applies where the badge is a real inline box |
| Icon        | `[&>svg]:size-3`                              | A direct child icon is 12px; call sites pass no size                                      |

The badge owns geometry and nothing else. Typography and foreground stay with the caller, because a badge reads as secondary beside body text in one place and as the value itself in another; pass `text-xs font-medium text-muted-foreground` or let the badge inherit its context. Width constraints and flex behaviour (`max-w-full`, `break-all`, `min-w-0`, `shrink-0`) also stay with the caller.

Tests scope badges through `data-slot="badge"`, which carries no styles. The icon rule and that slot follow shadcn's badge, which this package's components come from; the rest of shadcn's badge does not fit, because it bakes in `text-xs font-medium` that the diagnostic chips inherit from their row instead, and `whitespace-nowrap overflow-hidden` that would stop the long key/value chips from wrapping.

Line height belongs to the badge because a font-size utility with an arbitrary value carries no paired line height. A badge that declared only `text-[11px]` therefore took its box from whatever `line-height` an ancestor happened to set: the same badge measured 22px, 26px, or 34px tall across four ancestors. It reuses the page-surface border tokens rather than declaring badge-specific aliases, so one hairline decision keeps one owner.

Merge the badge's line height **after** caller classes. `tailwind-merge` removes an earlier line-height utility when a later font-size utility appears: `text-xs` replaces it with its paired line height, while `text-[10px]` leaves line height inherited. The badge keeps `leading-snug` last so both named and arbitrary font sizes retain the same unitless ratio. Callers choose the font size, not a separate line height.

Control typography is a joint decision about font size, line height, height, and padding. Keep that decision in the shared component; fixed-height buttons and segments retain their own size scales. A line-height ratio is not a promise to center every label's ink: capitals, descenders, and fallback fonts have different extents. Verify stable baselines, descender clearance, icon alignment, and long-label wrapping in a browser across representative Latin and Chinese labels. Do not shift individual labels or impose a font-metric threshold on every control to make one word look centered.

The `okou-badge`, `okou-pill`, and `okou-border-r` selectors and their consumers have been removed. `okou-pill` was scoped to `.okou-app` and set the muted foreground; its only consumer now spells that foreground itself. `okou-border-r` was a single settings-dialog divider and became `border-r border-r-gray-300` on that nav, keeping its lighter Gray 300 stroke while its width joins the shared hairline token.

### Chat scrollbars

`ScrollBar` from `@okouai/ui` owns the shadcn Base UI scrollbar styling shared
by the chat sidebar and message pane. Compose it with Base UI's
`ScrollArea.Root`, `ScrollArea.Viewport`, and `ScrollArea.Content`. The vertical
track is 10px wide with 1px padding, a transparent left border, and a flexible
rounded `bg-border` thumb. Base UI hides it when content does not overflow.
Callers retain their viewport refs, scroll handlers, content layout, and
scroll-position ownership; they do not add scrollbar width, color, or offset
overrides. The documented `scroll-area-viewport`, `scroll-area-scrollbar`, and
`scroll-area-thumb` slots identify the shared parts for browser verification.

### Icon controls and dialog bodies

`IconButton` from `@okouai/ui` owns a neutral 36px square control, the shared
radius, muted hover fill, and keyboard focus ring. Its `aria-label` is required;
callers provide the icon, foreground, opacity, and positioning. It reuses
`ButtonBase` for native button behavior, refs, render/asChild composition, and
optional tooltip support. Tooltip stays off by default. Use `Button` for action
variants; `IconButton` preserves the neutral dialog and sheet close treatment.
Compose it through `DialogClose` or `SheetClose` using `render` so Base UI keeps
ownership of closing and focus restoration, with one native button in the DOM.

`DialogBody` owns a native scrolling body and its thin scrollbar. It adds no
wrapper: layout, padding, and grid columns stay with the caller. Set
`scrollable={false}` when a child owns scrolling, as in the plan-selection grid
below a fixed header; the body keeps the same DOM element across step changes.
The existing `overflow-hidden` override used by artifact previews is retained.
The default `DialogContent` inner container also uses `DialogBody`, preserving
its `dialog-inner` slot and its protected vertical scrolling.

Scrollbar styling is private to `DialogBody`, not an exported class-name API.
Tailwind arbitrary variants address WebKit pseudo-elements. The component owns
the 6px width, 3px thumb radius, 4px vertical track inset, transparent track,
and neutral thumb colors, including hover. All default dialog bodies use this
treatment, including the existing workflow-recommendation detail body; artifact
previews retain their own clipping and internal scroll ownership.

The `icon-button`, `dialog-scrollable` and `icon-tooltip-trigger` selectors and
their dependencies have been removed. `IconTooltip` merges its disabled-child
wrapper's utilities with `cn()`, and the Mermaid diagram box passes its own
`wrapperClassName` into that slot.

### Animated layers

`RunningIndicator` owns its Tailwind utilities directly in JSX. Reuse the
component through its props; its internal class strings are not an exported
styling API. Both animated layers set their resting offset through an arbitrary
`[transform:translate(-50%,-50%)_scale(...)]` rather than Tailwind's
`translate-*` and `scale-*` utilities.

That is not a style preference. Those utilities set the individual `translate`
and `scale` CSS properties, while the keyframes animate `transform`. The
individual properties compose with an animated `transform` instead of being
replaced by it, so the layer would carry the centring offset twice for the whole
cycle. Measured, the naive form moves roughly 20,000 pixels of the indicator at
every sampled phase.

Register a keyframe animation as an `--animate-*` theme entry so consumers reach
it through `animate-*` rather than an `animation` shorthand. A per-instance
runtime value, such as the indicator's phase-anchoring
`--running-indicator-delay`, stays a narrowly named custom property that the
component sets, read through an arbitrary `[animation-delay:var(...)]`.

The `running-indicator`, `running-indicator-center`, and
`running-indicator-ripple` recipes have been removed; their keyframes remain,
since keyframes are not class selectors.

### Literal colours and gradients

Tailwind's colour and gradient utilities interpolate in oklab, so they do not
reproduce a literal `rgb()` fill or a plain `linear-gradient()`. Migrating the
mic meter with `bg-white/[0.18]` and `bg-linear-to-t from-[#bdf9ff] to-white`
changed 618 pixels against the retired rule; the exact forms
`bg-[rgb(255_255_255_/_0.18)]` and
`bg-[linear-gradient(to_top,#bdf9ff,#ffffff)]` reproduce it at zero. Reach for
the ergonomic utilities when a token supplies the colour, and for an exact
value when the retired rule named one.

The mic starting spinner sets `[transform:rotate(0deg)_translateZ(0)]` for the
same reason the running indicator does: its keyframes animate `transform`, and
Tailwind's `rotate-*` utility sets the individual `rotate` property, which would
compose with the animation rather than be replaced by it.

The legacy mic volume meter has since been retired; the voice draft tray owns
the recording waveform.

The `mic-starting-spinner` and `mic-volume-icon-meter` selectors have been
removed; the `mic-starting-spin` keyframes remain.

### Ancestor state without the hover media query

Tailwind wraps `hover:` and `group-hover:` in `@media (hover: hover)`, so a
`group-hover:` utility is not an equivalent replacement for a retired
`.parent:hover .child` rule: the retired rule also fired on coarse pointers,
where a tap leaves a sticky hover. Reproduce that contract with an arbitrary
variant over the element's own semantic attribute, as in
`[:is([data-sidebar-chat-thread-id]:hover,[data-sidebar-chat-thread-id]:focus-visible)_&]:…`,
which generates the same unconditional descendant selector at the same
specificity, and folds a two-state rule into one utility. This matches the
unconditional `[&:hover]` form the choice and surface variants already use;
reach for `group-hover:` only when the media gate is wanted. The sidebar copy
foreground above is such a case: it keeps the guard deliberately, because a
foreground that never repaints on a sticky tap state is the better behaviour
there, while a title that never scrolls to its end would lose the affordance.

Spell such a variant out at every call site. Tailwind's scanner is text-based,
so a variant assembled from a constant produces a candidate that never appears
in the source and therefore generates no CSS at all.

A retired `@media (prefers-reduced-motion: reduce)` override that reset a value
back to its initial becomes `motion-safe:` on the rule it used to override,
rather than a second `motion-reduce:` utility. Both utilities land in the same
layer at the same specificity, so a `motion-reduce:` override would depend on
Tailwind's emission order to win; `motion-safe:` simply does not apply, and the
registered initial value is what reduced motion resolved to anyway.

The sidebar thread title keeps its `@property --okou-nav-title-shift`
registration in the App stylesheet. A registration is an at-rule rather than a
class selector, and it is what lets a transition interpolate the length and
`inherits: true` carry the animated value to the text span; the mask, the
travel and the delayed hover transition are Tailwind utilities on the component.
The `okou-nav-title`, `okou-nav-title-row`, and `okou-nav-recent-label`
selectors and their consumers have been removed. `okou-nav-recent-label` had no
declarations at all. `data-slot="sidebar-thread-title"` identifies the clipping
box for page tests and carries no styles.

### Neutral button and select variants

Use `Button variant="neutral"` for neutral actions and
`SelectTrigger variant="neutral"` for neutral select controls. Each component
owns its utilities; their public API does not export class strings.
Use `Button asChild variant="neutral"` around a router `Link` for navigation
styled as a button, and compose `Button` with `DialogTrigger` for dialog
actions. The existing components own the interaction contract; `neutral` is
only a visual variant. Link composition preserves the native anchor, ref,
and navigation behavior without adding a wrapper.

The components compose `border border-control-border bg-control-surface
text-foreground [&:hover]:bg-state-hover-overlay` internally. This is the treatment the
settings-select batch established, extended with the border and foreground the
retired `okou-btn-morandi` selector owned. Language, timezone, and voice-input
settings all use the select variant. Dimensions, padding, and radius remain
with the existing component and caller.

The neutral button states both interactions as overlays
(`[&:hover]:bg-state-hover-overlay [&:active]:bg-state-pressed-overlay`) above
that surface, and select triggers do the same for hover. It previously also
carried the outline fills `hover:bg-state-hover active:bg-state-pressed`, which
is the contradiction the state-layer note above describes: those utilities set
`background-color`, so they replaced `bg-control-surface` rather than sitting on
it. `gray-50` is a warm stop (hue 15°, saturation 40%) and the state layer is
neutral, so hovering measured `#FCF9F8` → `#F1F0F0` and dropped the warm cast
the resting fill carries. Overlays alone measure `#F5F2F1`, which stays in the
same family. The existing recovery links and Add automation trigger keep
`hover:bg-control-surface active:bg-control-surface` on their `Button`
instances; those overrides used to cancel the replacing fill and are now
redundant, and they render identically either way.

Preserve consumer-specific interaction colors when extracting shared styles.
The official workflow Configure button, for example, retains its existing
`hover:bg-primary-hover active:bg-primary-pressed` overrides.

The retired rule hard-coded a `0.7px` border while the rest of the product had
already moved to `--default-border-width`. The replacement takes the shared
hairline instead of naming a width. Blink and Gecko round both values up to one
device pixel, so the change is invisible there and layout is unchanged; WebKit
may draw the true hairline on a high-density display, which is the product
behaviour the shared token already describes.

`text-foreground` is currently redundant at every consumer, because each one
already inherits that foreground. It is kept because the retired rule set it,
so a control moved onto a differently coloured surface keeps the treatment it
has today.

The `okou-btn-morandi` selector has been removed.

### Sidebar copy under the gradient color themes

The `okou-nav-copy`, `okou-nav-copy-muted`, and `okou-nav-copy-muted-hover`
selectors have been removed. They were scoped to
`.okou-app[data-gradient-color-themes]` and collapsed every nav consumer onto one
foreground and one muted foreground, overriding whatever each consumer spelled
for itself. The collapse now happens at the variable layer instead:

```css
:root[data-gradient-color-themes][data-color-theme] {
  --nav-copy: hsl(var(--okou-color-theme-hue) 24% 18%);
  --nav-copy-muted: hsl(var(--okou-color-theme-hue) 18% 38%);
}
```

```css
--color-nav-copy: var(--nav-copy, var(--color-sidebar-foreground));
--color-nav-copy-muted: var(--nav-copy-muted, var(--color-muted-foreground));
```

When the gradient themes are on, the raw values exist and every consumer resolves
to them. Everywhere else they are unset and each consumer falls back to the
foreground it already had, so both sides keep their current appearance without a
conditional selector. Consumers whose foreground matches a registered fallback
use `text-nav-copy` or `text-nav-copy-muted`; the rest carry their own fallback
in the utility, including `var(--nav-copy, inherit)` where the consumer inherits
its colour from an ancestor `Link` or `button` and must keep inheriting that
ancestor's hover.

Measured against `main` with the App's own Tailwind compiler in Chromium over
CDP — 18 theme states, 19 class variants, hover forced on every row and on its
colour-bearing ancestor: zero changed computed colours on the default palette and
zero on all eight gradient palettes. A negative control that perturbs one
fallback reports changes on both, so the zeros are not degenerate.

One difference remains on a coarse pointer: `group-hover` carries Tailwind's
`@media (hover: hover)` guard, which the retired selector lacked, so the gradient
themes no longer paint the hover foreground onto a sticky tap state. Removing
that guard would need either a first-party selector or a global `hover` variant
override, and the guard is the better behaviour.

Sidebar thread titles carry `data-slot="sidebar-thread-title"` so tests select
them through a documented slot instead of the styling class.

### Nav chrome under the gradient color themes

The `okou-nav` selector and its consumers have been removed. It carried five
declarations across four rules, and it was the scoping ancestor the rail fill
needed: `.okou-app[data-gradient-color-themes] .okou-nav.okou-nav-rail` painted
the rail's background, so deleting the class alone would have unscoped that
compound selector and dropped the rail tint under every gradient palette.

Three of the five declarations were inert. `.okou-nav` re-declared
`--color-sidebar-border` as `hsl(var(--gray-200))`, which is already the App
`@theme` default, and the gradient and dark rules re-declared `--color-sidebar`
as `hsl(var(--sidebar))`, which document scope already set to the same
substituted value. `--sidebar` and `--gray-200` are only ever assigned at
document scope, so re-anchoring them on a descendant could not change what the
nav resolved. Removing all three is measured below as zero change, including
for descendants that read the inherited tokens.

The two live declarations were gradient-only, and they collapse to the variable
layer the same way the nav copy above does:

```css
:root[data-gradient-color-themes][data-color-theme] {
  --nav-rail: hsl(var(--okou-color-theme-hue) 36% 93.5%);
  --nav-border: hsl(var(--border) / 0.5);
}
```

```css
--color-nav-border: var(--nav-border, var(--color-sidebar-border));
--color-nav-rail: var(--nav-rail, var(--color-sidebar-rail));
```

The rail composes `border-nav-border bg-nav-rail` and the expanded drawer
composes `border-nav-border`. With the gradient themes on, the raw values exist
and both resolve to them; everywhere else they are unset and each consumer falls
back to the shared sidebar token it already read. `--okou-nav-rail` is renamed
to `--nav-rail` rather than kept beside it, because the retired rule was its
only reader.

This narrows a contract on purpose. The retired rules overrode an _inherited_
token on the whole nav subtree, so any descendant spelling
`border-sidebar-border` silently took the gradient alpha; the replacement is an
explicit utility that a consumer opts into. The three nav elements are the only
consumers of `border-sidebar-border`, `bg-sidebar` and `bg-sidebar-rail` in
Platform and UI today, so nothing changes now, and a future nav descendant that
wants the gradient stroke asks for `border-nav-border` by name.

`.okou-nav-rail` stays on the rail element and now carries no declarations. It
is neither in the legacy baseline nor in a batch, so retiring it belongs to
whichever change closes that gap, not to this one. The expanded drawer carries
`data-slot="sidebar-expanded"` so the account-menu test selects it through a
documented slot instead of `aside.okou-nav:not(.okou-nav-rail)`.

`GradientColorThemes` is `enabled: false` with no organization allowlist, so the
default palette is the online-visible path and every gradient palette is a
superset behind the switch.

Measured against `main` with the App's own Tailwind compiler in Chromium over
CDP, across 36 captures — the default palette plus all eight gradient palettes,
each in Light and Dark, at desktop 1280x900 DPR 1 and narrow 700x900 DPR 2:
zero changed pixels and zero changed rendered properties on every capture,
online-visible path included. A second fixture adds descendants that read the
inherited sidebar tokens; there the only difference is the intended one, the
`border-sidebar-border` probe losing its gradient alpha inside the nav, and the
`bg-sidebar`, `bg-sidebar-rail` and `text-sidebar-foreground` probes are
unchanged, which is what establishes that the three inert declarations were
inert. Negative controls that drop the rail fill, shift the border alpha by
0.05, and shift the rail lightness by 0.5% all report changes, so the zeros are
not degenerate.

### Horizontal hairline rules

The `okou-border-t` selector and its consumers have been removed. It was one
declaration — `border-top: 0.7px solid hsl(var(--gray-400))` — spelled at 27
sites as the rule between rows of a settings card, list or menu. Each consumer
now writes `border-t border-t-gray-400`.

The width joins the shared hairline the same way the retired `okou-btn-morandi`
border did: `border-t` reads `--default-border-width` rather than naming a
value, so these rules stop being a second registry for a decision that token
already owns. The colour is unchanged, because `border-t-gray-400` resolves to
the registered `--color-gray-400`, which is `hsl(var(--gray-400))` — the same
runtime variable the retired rule read. Every Dark and gradient-palette override
it followed therefore still applies without a per-theme branch.

These are rules rather than real borders, so the newer `bg-divider` guidance
would suit them. Adopting it would change their colour, which is a visual
decision and belongs to a separately reviewed change; this migration preserved
the existing stroke.

The shared `Select` and `DropdownMenu` separators compose these utilities
alongside their existing `border-0`. That still paints, because Tailwind emits
`border-width` before `border-top-width` inside the utilities layer; previously
the legacy rule won only by sitting outside every layer. Tests continue to
select both separators through `data-slot`.

### The all-round hairline

`okou-border` is the four-sided sibling of the rule above: one declaration,
`border: 0.7px solid hsl(var(--gray-400))`, carried by settings cards,
diagnostic panels, org-management tables, the queue drawer's plan cards, the
instructions editor's bubble menu and a handful of pills and chips. Twenty-eight
of its consumption sites now write `border border-surface-border`; the two that
already spelled a bare `border` add only the colour.

`--color-surface-border` is `hsl(var(--gray-400))`, the same runtime variable the
retired rule read, so every Dark and gradient-palette override still applies
without a per-theme branch. It is the registered name for this decision — the
page-surface and badge tables above already point at it — which is why these
consumers take it rather than the raw `border-gray-400` ramp stop the horizontal
rules kept. `border-border` would be wrong here: `--border` is `--gray-300`, one
stop lighter.

The width joins the shared hairline exactly as `okou-btn-morandi` and
`okou-border-t` did. Measured in Blink, `0.7px`, `0.5px` and `1px` all resolve to
a used width of `1px` and paint 1, 2 and 3 device pixels at device scale factors
1, 2 and 3 respectively — the same count for all three — so dropping the
hard-coded `0.7px` is invisible there and layout is unchanged. WebKit may draw
the true hairline on a high-density display, which is the product behaviour the
shared token already describes.

The selector itself stays for now. `buy-credits-section.tsx` reaches for it from
a function that returns a class string rather than from a `className` attribute,
so neither the legacy baseline nor `no-unknown-classes` counts it, and that one
consumer is not mechanically drainable: the retired rule is unlayered, so its
`border` shorthand outranks the sibling `hover:border-muted-foreground/30` on the
same element and that hover colour never paints. Replacing only the legacy class
activates it. Deciding between keeping a hover the tile has never had and
deleting a utility the consumer spells is a visual decision, not an equivalence,
and it is reviewed separately.

### Page layouts

Choose the existing layout that owns the page structure. Route setup selects
`pageLayout$`; the Router's `LayoutHost` supplies `SidebarLayout` or
`StandaloneLayout`, and the page supplies the content inside it.

| Component                                         | Use it for                                                                                               | Placement                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `SidebarLayout`                                   | Workspace pages with navigation and a workspace pane                                                     | Selected by the router's `sidebar` layout    |
| `StandaloneLayout`                                | Independent flows with shared theme and dialogs, such as authorization, browser sessions, and redemption | Selected by the router's `standalone` layout |
| `OnboardingShell`                                 | Step-based onboarding with progress, account controls, and an optional footer                            | The onboarding page's outer layout           |
| `PageShell` in `okou-page/connect-page-shell.tsx` | Connector sign-in, authorization, and status content in a centered card                                  | The connection page's outer layout           |
| `DirectedCardShell`                               | Connector-specific title, icon, description, and actions in a centered handoff card                      | Content inside `StandaloneLayout`            |
| `DetailPageShell`                                 | A detail page's flex and scroll container                                                                | Content inside an existing workspace layout  |

Pages rendered inside a shared layout reuse that layout's outer container.
Independent pages that already own their structure, such as `ExportPage`, keep
their native root element.

Viewport sizing stays on the existing native roots through
`box-border h-full max-h-full min-h-full overflow-hidden`. Page roots reserve
the bottom safe-area inset with `pb-(--sab)`; `SidebarLayout` uses `pb-0` so its
scrollports reach the viewport edge and its content/composer owns the inset.
Document sizing, top and horizontal insets, and PWA keyboard handling remain
owned by the existing global environment rules. The `okou-viewport-shell`,
`okou-managed-bottom-safe-area` and `okou-fixed-viewport-shell` selectors and
their consumers have been removed.

A page that covers the viewport is the exception to the paragraph above. The
browser session page is `fixed inset-0`, so it is positioned against the
viewport rather than inside `#root` and inherits none of the insets that element
applies; `#root` reserves the top and horizontal insets for every route, but a
fixed descendant is laid out past them. That page therefore takes all four
insets with `p-safe` and pins its own height with
`h-viewport max-h-viewport min-h-viewport`.

Both are registered names rather than respelled variables, for the reason the
`--animate-*` entries above give: a consumer should reach a decision through its
utility, not restate the declaration. `--height-viewport` is an `@theme inline`
entry over `--okou-viewport-height`, so `h-viewport` emits that variable
directly and `@media (display-mode: standalone)` still decides at use time — it
is not `h-dvh`, because standalone moves the variable to `100lvh`. A percentage
would not do either: `h-full` on a fixed element resolves against the viewport
rather than the height the rest of the app measures.

`p-safe` is an `@utility` instead of a theme entry because its four sides carry
four different values, which no single spacing token can express. Registering it
is not an exception to the selector boundary: `@utility` emits into
`@layer utilities` and declares no class selector, so the shrink-only baseline
does not record it.

A page does not restate the shell it renders inside. This one is mounted with
the `standalone` layout, so `StandaloneLayout` is its ancestor and already
carried the shell class along with the theme attributes; the page's own copy of
that class was redundant and went first, and the class itself is gone now. `position: fixed` changes where a box is laid
out, not where it sits in the DOM, so the shell's custom properties still
inherit into the cover.

The retired rule was unlayered, which decided one value that the utilities now
have to state outright. The element also carried `min-h-0`, and the rule's
`min-height` outranked it from outside every layer, so the page has always
measured the viewport height rather than zero. `min-h-0` is dropped rather than
kept beside the new `min-h-viewport`: the two would be one `@layer utilities`
apart with nothing left to break the tie, and the value the browser computes
today is the viewport one. `box-sizing: border-box` reappears
as `box-border` for the same reason the sibling page roots spell it — the base
layer's universal rule already sets it, but the shell owns its own box model
rather than depending on that.

Pixel evidence for this batch was never captured; the equivalence argument
above is the whole of it.

### Top-edge clearance

A control that meets the top edge of the surface holding it clears that edge by
24px, and never by less than the vertical gap between the items below it.
`DialogContent` carries `p-6` and the shared `DetailPageHeader` carries `pt-6`,
so a page that composes its own header owes the same value rather than a smaller
one of its own. The edge is read against the group's own rhythm: a clearance
equal to the gap inside the group makes the first control read as cropped by the
edge instead of placed against it.

A sticky strip is measured in the state it is latched in, not only at rest. The
connectors toolbar hands the page's top padding back with a negative margin and
restates it as its own padding, so that padding is the clearance the segment
control keeps once the strip is pinned to the scrollport. Page padding and strip
padding therefore come from one value; raising only the strip would move the
controls at the moment it latches. A header that hides its content at a
breakpoint stops contributing padding there, so below `md` the page's own top
padding owns the whole clearance.

### Table header rules and the global scrollbar treatment

The `table-wrapper` selector and its injected stylesheet have been removed. It
was the last `jsx-style` injection in `@okouai/ui`: a `dangerouslySetInnerHTML`
`<style>` element that `Table` rendered on every mount, carrying eight rules at
one consumption site.

Five of those eight rules were the scrollbar treatment — `scrollbar-width`,
`scrollbar-color`, and the three `::-webkit-scrollbar*` rules. The App stylesheet
already applies exactly those declarations to `*`, with identical values, so the
wrapper's copies were duplicates of a rule that already covered them. They are
not respelled as utilities; removing them is enough. `@okouai/ui` is consumed
only by the App, which imports that stylesheet, so no consumer loses the
treatment. Reach for the scrollbar utilities only where a surface wants
something other than the global treatment, as `DialogBody` does.

The `tbody tr:last-child` rule was also redundant: `TableRow` already spells
`last:!border-b-0`, and a layered important declaration outranks an unlayered
one, so the row utility was already deciding that border.

The two load-bearing rules were the header separator and its suppression on the
header row. `TableHeader` now writes `border-b border-b-border
[&_tr]:border-b-0`. The retired rule hard-coded `1px`, and the replacement takes
the shared hairline instead of naming a width, the same way the retired
`okou-border-t` and `okou-btn-morandi` borders did.

Here that is not even a hairline trade. Tailwind's Preflight sets
`border-collapse: collapse` on tables, and a collapsed border resolves to a whole
CSS pixel: measured in Chromium, a `<thead>` with the 0.5px
`--default-border-width` and one with a literal `1px` both report a computed
`border-bottom-width` of `1px`, both leave the table 92.5px tall, and both paint
one device row at device scale 1 and two at device scale 2. The hairline's
half-ink behaviour described above applies to separate borders, not to a
collapsed table edge.

`[&_tr]:border-b-0` is currently redundant for the same collapsing reason: the
header row's own `border-b` loses to the row-group border at the same boundary,
and dropping the utility changes no pixels. It is kept because the retired rule
declared it, so a header row that later carries a wider border keeps today's
appearance. Leaving the separator to `TableRow` instead is not equivalent — a row
border never wins that boundary, so the header rule simply disappears and every
body row shifts up.

### Chat message bubbles

The `okou-chat-bubble-user` and `okou-chat-bubble-assistant` selectors and their
consumers have been removed. Between them they carried seven declarations over
four rules: the user bubble's fill and foreground, the assistant bubble's
transparent fill and `border: none`, the 8px block spacing the Markdown body
inside either bubble used instead of the App's 6px default, and the assistant
bubble's suppressed horizontal rules.

The two fills are ordinary utilities. The user bubble writes `bg-gray-200
text-foreground` — `--color-gray-200` and `--color-foreground` are the
registered names for `hsl(var(--gray-200))` and `hsl(var(--foreground))`, the
same runtime variables the retired rule read, so every Dark and
gradient-palette override still applies. The assistant bubble writes
`bg-transparent border-none border-current`. The colour utility is there because
`border: none` is a shorthand: it reset `border-color` to `currentcolor`, while
`border-none` sets only the style. The width is 0 either way, so this is
invisible today; it is kept because the retired rule decided it, so an assistant
body that later carries a border keeps the treatment it has now.

The Markdown block treatment is different in kind, because it applies to
elements the Markdown library renders. `MarkdownEventBody` takes a `chatBubble`
prop and composes the whole treatment onto the frame it already owns:

```
[&_:is(p,[data-slot=markdown-card])]:my-2! [&>*:first-child]:mt-0!
[&>*:last-child]:mb-0! [&_blockquote]:py-2!
[&_blockquote>*:first-child]:mt-0! [&_blockquote>*:last-child]:mb-0!
[&_hr]:hidden
```

Every margin there is important, and the four resets exist only because of it.
The competitor for the paragraphs is the App's own unlayered `.wmde-markdown p`
rule, which a utility in `@layer utilities` cannot outrank without one; a layered
important declaration does. The card slot has since been drained to a `my-1.5`
utility of its own, which the important declaration outranks from inside the same
layer, so both halves still land on the bubble's 8px. That same promotion also
clears the vendored `.wmde-markdown > *:first-child` / `> *:last-child` resets,
which carry `!important` and therefore beat every unlayered rule whatever the
source order is. The retired rule lost to those two, so restating them at the
same tier is what keeps the frame's own edge paragraphs flush.

The vendored `blockquote > :first-child` / `:last-child` pair is a different
case, and the source order decides it. That order runs the other way from what
this section first recorded: the Markdown chunk's stylesheet reaches the bundle
through a static `router.tsx` import chain that `main.tsx` evaluates before its
own `./css/index.css`, so Rollup emits the vendored rules first and the App
block wins every tie. The pair is not important and ties the retired
`.okou-chat-bubble-* .wmde-markdown p` rule at (0,2,1), so the retired rule won:
inside a bubble, a blockquote's first and last paragraph carried its 8px.
`[&_blockquote>*:first-child]:mt-0!` and its `mb-0!` sibling flush those two
edges instead. See the Markdown body batch in the migration log for the
measurement.

That 8px was never spacing inside the quote, which is why flushing those edges
looked inert and why restoring the margin would not bring it back. A blockquote
here declares `padding: 0 1em` and a left border only, so a first or last
child's block margin has no block padding or border to stop it and collapses
straight out through the quote's own edges. Measured across a quote between
paragraphs, alone, first, and last in the body, the inset from the quote's edge
to its first and last line was 0px both before and after that change; the only
geometry that moved was 8px of leaked space at the bubble's own top and bottom,
which is exactly what the vendored `> *:first-child` reset exists to remove.
`[&_blockquote]:py-2!` gives the quote the bubble's 8px as block padding, where
it is both visible and contained, and the flushing pair is what keeps the inner
margins from adding a second, escaping copy. Resolves
[#34278](https://github.com/vm0-ai/vm0/issues/34278).

The padding needs its important for the same reason the margins do, and for a
sharper reason: `.wmde-markdown blockquote` declares `padding: 0 1em` unlayered,
and an unlayered normal declaration outranks a layered one whatever its
specificity. A non-important `[&_blockquote]:py-2` compiles and matches but
changes nothing. `[&_hr]:hidden` needs no important, because nothing unlayered
declares `display` on a Markdown rule.

The card slot is addressed through `data-slot="markdown-card"` rather than its
`okou-markdown-card` class. At the time this batch landed that was because
naming a legacy class inside an arbitrary variant registers a new dependency on
it under the shrink-only baseline; the class has since been drained, so the slot
is now the only handle the element has. The slot carries no styles. `data-slot="chat-user-message"` likewise
replaces the attachment-preview test's `.okou-chat-bubble-user` query.

This narrows a contract on purpose, the way the nav chrome above does. The
retired rules applied to _any_ Markdown frame that happened to sit inside a
bubble; the replacement applies to the three call sites that ask for it — the
chat transcript's Agent message, and the shared thread's rendered and
rich-content Agent messages. Those are every Markdown frame inside a bubble
today, so nothing changes now, and a future in-bubble frame asks for the
treatment by name.

Two of the four retired rules were already partly dead.
`.okou-chat-bubble-user .wmde-markdown p` and its `.okou-markdown-card` sibling
never matched: a user bubble's body renders spans and reference chips through
`UserMessagePartView`, the shared thread's renders plain text, and the
automation and goal bubbles render plain text, so no Markdown frame has ever
existed inside one. Both bubble names also remain in the
`.okou-app[data-desktop-shell] :where(…)` selection exception, which nothing in
the repository can activate for the reason the titlebar section below records;
that block belongs to the `okou-app` batch and is deliberately untouched here,
so the two class names stay inside it while no element carries them. That
selection exception is the last `[data-desktop-shell]` block in the stylesheet.

Measured against `main` with the App's own Tailwind compiler (the 4.2.2 engine
the Vite plugin bundles) in Chromium over CDP, across 28 captures — the default
palette in Light and Dark at desktop 1280x1400 device scale 1 and 2 and narrow
700x1400 device scale 2, each with and without the fine-pointer hover flags,
plus all eight gradient palettes in Light and Dark at the desktop geometry:
zero changed pixels and zero computed-style or geometry differences on every
capture. `GradientColorThemes` is `enabled: false` with no organization
allowlist, so the default palette is the online-visible result and the palette
states are a superset. The fixture
rebuilds the real ancestor chain down to the bubble and reproduces the Markdown
frame's element, a first/middle/last paragraph, a loose list item, a blockquote,
both card forms, a horizontal rule, and the single `<p class="m-0">` the plain
Markdown path renders. The capture is taller than a real viewport on purpose:
the chat pane scrolls inside an absolutely positioned container, so the document
never grows and a page-height capture would compare only the first turn.

Six negative controls establish that those zeros are not degenerate. Dropping
the paragraph/card spacing changes 214,329 pixels on desktop Light and 10,227,660
over all 28 captures; dropping the first-child reset changes 108,927 and
5,131,289; dropping the rule suppression changes 211,552 and 10,147,418;
dropping the user bubble's fill changes 32,890 and 1,690,648. The remaining two
are invisible by construction and are caught by the observation channel alone:
dropping the blockquote reset changes one observed margin per capture at zero
pixels, and dropping `border-current` changes three observed border colours per
capture at zero pixels.

### Card geometry at the document root

`--okou-card-radius`, `--okou-chat-card-radius`, `--okou-card-shadow` and
`--okou-chat-card-shadow` are owned at `:root`, not inside the `.okou-app`
scope, for the reason `--okou-composer-focus-veil` already records: a portaled
surface is not a descendant of the app shell, so a scoped declaration never
reaches it. The palette override follows them, keyed on the
`data-gradient-color-themes` attribute `signals/theme.ts` writes onto the
document element.

That scope was carrying a defect. The queue drawer renders through
`SheetContent`, which Base UI wraps in `SheetPortal`, so its plan, upgrade and
concurrency cards and its two loading skeletons sit outside the shell. All five
ask for the card radius in their markup, `var(--okou-card-radius)` resolved to
nothing there, and `border-radius` fell back to its initial `0`: square corners
on surfaces whose own code requests 1.25rem, beside in-shell cards that are
rounded. Document scope gives them the radius they already ask for. Measured,
that is the whole change — the five in-shell consumers and a `bg-sidebar` fill
outside the shell report identical radius, shadow and background in Light and
Dark, with and without a gradient palette, while the three portaled surfaces
move from `0px` to `20px`.

A second `.okou-app` block declared `--color-sidebar` and `--color-sidebar-rail`
with values byte-identical to the `@theme` entries in
`@okouai/ui/styles/globals.css`. It overrode the shared tokens with themselves,
so it is deleted rather than promoted; the outside-the-shell `bg-sidebar` probe
above is what shows it carried nothing.

### The workspace canvas

The `okou-workspace-bg` selector and its consumers have been removed. It was a
`::before` paint layer behind the workspace pane, and it had four variants —
default and gradient palette, each in Light and Dark — that differed only in a
fill colour and a gradient. Those are two runtime values, so they are now keyed
at `:root` and reached through one `bg-workspace-canvas` and one
`bg-workspace-canvas-image`, registered as `@theme inline` entries over
`--okou-workspace-canvas-fill` and `--okou-workspace-canvas-image`. `inline`
keeps the reference, so the theme and palette attributes still decide at use
time.

Keying at `:root` is what removes the selectors, and it widens their scope on
purpose rather than restating the same condition. `signals/theme.ts` writes
`data-theme` and `data-gradient-color-themes` onto the document element, while
the retired gradient rules reached the canvas through a _descendant_
`.okou-app` that carried the palette attribute itself. Only the sidebar and
standalone shells carry it, so `workspace-inset.tsx` is the one consumer those
rules ever matched. `export-page.tsx`, `connect-page-shell.tsx` and
`shared-thread-page.tsx` carry `okou-app` on the canvas element itself and
never carry the attribute, so they always painted the default canvas, and they
still do — but because of a routing invariant, not because of the selector.
Their routes register with the `"none"` layout, so `LayoutHost` mounts neither
shell, `applyColorThemeDocumentAttributes` never runs, and
`:root[data-gradient-color-themes]` is never set while they are on screen.
Forced onto `:root` against a same-element fixture, the two sides do differ in
both gradient states. The canvas is therefore now available to any
`:root`-attributed context, which is the contract a future consumer inherits.
Each theme test wraps in `:where()` so it stays at the specificity of the rule
it refines and source order decides between them.

The retired dark rule matched `.dark .okou-workspace-bg::before` as well as the
attribute form. `applyTheme` always sets both, so the attribute alone is
equivalent, and dropping the class is required rather than optional: a class in
the selector registers a first-party class-selector declaration against the
shrink-only baseline, which is the same reason the composer veil records.

The gradient palette is measured through the computed-style harness rather
than by screenshot, because a route and a viewport do not pin a palette.

`before:bg-[length:100%_100%]` is retained although no measurement can move it.
`background-size: 100% 100%` and the initial `auto auto` size a gradient to the
same box, so dropping it changes zero pixels; it is kept because the retired
rule declared it and the computed value is part of what this drain preserves.

### The app shell class — drained

`okou-app` was the last first-party class in the platform-shell family, and by
the time it was removed it painted nothing. The card tokens moved to `:root`,
the dead `[data-desktop-shell]` selection rules were deleted, and the workspace
canvas collapsed onto registered utilities, which between them retired every
rule that named the class. What remained was the string itself on twenty
elements and a scope that selected nothing.

Deleting it is therefore not a visual change and there is nothing to measure:
after those three drains no stylesheet in the App or in `@okouai/ui` contains a
`.okou-app` selector, so no declaration reaches an element through it and no
computed value can depend on it. Two dialogs kept the class only to re-enter a
scope that no longer exists — `unsaved-bar.tsx`, whose comment said so
explicitly, and `instatus-status-notice.tsx` — and both now sit in the same
place with the same tokens, because those tokens are resolved at the document
root.

`sidebar-account-menu.test.tsx` used `document.querySelector(".okou-app")` to
decide whether the app shell was still mounted during an account switch. It now
queries `[data-slot="app-shell"]` on the same element, which is the one
`shellDocumentAttributesRef$` attaches to — so the probe reads the element that
actually owns mount state rather than one that happened to carry a styling
class. Only `SidebarLayout` declares the slot, because only that layout is
mounted on the route the test renders.

### Desktop titlebar drag region — drained

The `okou-desktop-no-drag` selector and its consumer were removed first. The
sidebar header and both drag regions then spelled their live treatment as
utilities: `pt-1.5` for the header's `padding-top: 0.375rem`, `hidden` for the
drag regions' `display: none`, and `[-webkit-app-region:no-drag]` for the
header row. `-webkit-app-region` has no Tailwind utility, and it is a real
declaration rather than a token decision, so it stays an arbitrary property.

That left one `@media (min-width: 768px)` block behind
`.okou-app[data-desktop-shell]` — four rules and nine declarations across
`okou-sidebar-header`, `okou-desktop-titlebar-drag-region` and
`okou-workspace-bg` — which has now been deleted outright, together with the
`--okou-desktop-titlebar-height` variable its only reader used, the
`okou-sidebar-header` class on the drawer header, and both `aria-hidden` drag
region divs. `okou-desktop-titlebar-drag-region` and `okou-sidebar-header` are
retired; `okou-workspace-bg` kept the fifteen declarations unrelated to the
desktop shell, and "The workspace canvas" above drains those.

**Nothing in the repository ever set that attribute.** It occurred only in the
App stylesheet, in the baseline derived from it, and in this document; there is
no DOM write anywhere in the App, the UI package, the
Desktop app, the Worker HTML, or a test. So the block never matched an element,
both drag regions were always `display: none`, and the header always kept its
6px inset. The header's `padding-top: 0` override was dead twice over, because
its only consumer sits inside the mobile drawer `aside`, which is `md:hidden`.
`.okou-workspace-bg`'s `position: relative` was dead three times over: the
unconditional `.okou-workspace-bg` rule already declares it.

The two unlayered `.okou-app[data-desktop-shell]` selection rules outside that
media block are now deleted as well, on the same evidence: one set
`user-select: none` on app chrome and one restored `user-select: text` inside
inputs, editors and the two chat bubbles. Measured on a reconstructed shell,
with the attribute absent — which is every shipped build — `user-select`
computes to `auto` on chrome, input and contenteditable both before and after.
Forcing the attribute on separates the two sides: before gives `none` on chrome
and `text` on the input, after gives `auto` for both. So the rules were real
rather than no-ops, and the only thing that ever kept them inert was an
attribute nothing writes.

That deletion also retires the last references to `.okou-chat-bubble-user` and
`.okou-chat-bubble-assistant`. The chat-bubble batch removed those class names
from every element and recorded that they survived only inside this selection
exception; with the exception gone, neither name appears anywhere in the
repository but this guide. With the card tokens promoted to
`:root` and the workspace canvas drained above, `.okou-app` no longer appears in
the stylesheet at all — it neither carries a declaration nor scopes one. The
class survives only on the elements that still spell it, which is what the
final call-site removal clears.

Deleting rather than porting is the right move because there is nothing to
port. A replacement could only be a condition no element satisfies, and
reproducing `.okou-app[data-desktop-shell] &` needs an arbitrary variant that
spells `okou-app` inside a `className`, which the class-usage scanner counts as
a dependency: that attempt fails `style-policy/growth` with `okou-app` usage
growing from 0 to 9, and `pnpm lint:style:prune` refuses to authorize it.

The behaviour the block described is not missing either.
`buildDesktopWindowChromeOptions` asks Electron for
`titleBarStyle: "hiddenInset"` with the traffic lights at `{ x: 16, y: 18 }` on
darwin, which is precisely the layout a 48px drag region is written for — but
that layout is already paired, in the Desktop renderer's own stylesheet rather
than this one. `apps/desktop/src/main.ts` loads `desktopRendererUrl()`,
`vm0-desktop://renderer/index.html`, and `renderer/styles.css` gives its
`.app-header` `-webkit-app-region: drag` at the renderer's own titlebar height,
with `no-drag` exceptions on its controls and three more drag/no-drag pairs in
the recorder window. `okou-app` appears nowhere under `turbo/apps/desktop`, so
neither this stylesheet nor a `.okou-app` element is in that document. **Desktop
window dragging works; this was never the code that implemented it.**

These rules were residue of a different integration, one that was never built:
rendering the Platform UI inside the Desktop shell.
[Issue #34162](https://github.com/vm0-ai/vm0/issues/34162) records that. The
block becomes relevant again only if someone decides to host the Platform UI in
the Desktop shell, and that drag chrome would then be designed with the decision
rather than resurrected from a selector that had been inert since it was
written. Note that Platform markup does reach an Electron window in one place
today — the auth window `desktop-auth-window.ts` opens on the `/desktop-auth/*`
routes — and that window sets no such attribute either.

Measured against `main` with the App's own Tailwind compiler (the 4.2.2 engine
the Vite plugin bundles) in Chromium over CDP. The fixture rebuilds the real
ancestor chain — the `.okou-app` shell from `sidebar-layout.tsx`, the
`md:hidden` drawer `aside`, the `hidden md:flex` labelled rail, and the
`WorkspaceInset` with one element of every kind the retired `:where(…)` row
selects — and carries `apps/platform/index.html`'s verbatim viewport meta,
without which mobile emulation lays out at 980px and silently satisfies
`min-width: 768px`. Twenty-four captures per side: desktop 1440x1000 at device
scale 1 and 2 and narrow 390x844 at device scale 2, Light and Dark, fine- and
coarse-pointer media, with `data-desktop-shell` absent and forced on, and
`:hover` forced on every probe and on every ancestor up to the shell root.
`GradientColorThemes` is `enabled: false` with no organization allowlist, so the
default palette is the online-visible result.

On the twelve online-visible captures — the attribute absent, which is the only
state that has ever shipped — zero changed pixels, zero alpha changes, and zero
computed-style or geometry differences on every surviving element. The only
observation differences are the two deleted drag-region divs.

Two negative controls establish that those zeros are not degenerate. Forcing
`data-desktop-shell` onto the shell root changes 5,813 pixels per desktop
capture at device scale 1 and 23,015 (Light) / 23,029 (Dark) at device scale 2,
and moves `padding-top`, `display`, `height`, `flex-shrink`, `position`,
`z-index` and `-webkit-app-region` on eleven probes — so the harness does reach
the deleted block. Forcing the attribute cannot move the narrow captures,
because 390px never satisfies `min-width: 768px`; a second control that drops
the header's live `pt-1.5` changes those by 7,526 (Light) / 7,521 (Dark) pixels,
so the narrow captures are sensitive too. An unchanged-code A/A replay is
byte-identical across all 24 captures, so no rounding budget is claimed.

### Third-party attribution of borrowed class names

A class that looks like a vendor's is not automatically that vendor's. The
exception boundary follows who authors the element, not who the name resembles.

The queue drawer's check icon was a hand-written SVG in
`queue-page/queue-drawer.tsx` that spelled `lucide` in its own `className`.
Lucide never rendered it; the class was there to opt into the first-party
`svg[class*="lucide"][stroke-width="2"]:not([data-stroke])` rule that normalizes
the vendor's default stroke. A first-party element borrowing a vendor
fingerprint to reach a first-party rule is legacy debt, not an adapter, so it
takes a utility instead, and the icon stroke token moves into the namespace that
already owns that decision. Tailwind resolves `stroke-*` against `--stroke-width-*`
before it falls back to a bare number, so renaming `--icon-stroke-width` to
`--stroke-width-icon` turns the token into the plain named utility `stroke-icon`,
which emits the same `stroke-width: var(--stroke-width-icon)` the retired rule
matched into. That is the shape the emoji spans ended at with
`font-family-emoji`: a registered token read through its own namespace, not a
custom property threaded through an arbitrary or data-type-hinted utility. Bare
`stroke-2` keeps working, because the namespace lookup only precedes the numeric
fallback. The element's own `strokeWidth="2"` presentation attribute stays,
because CSS outranks it either way and the retired rule keyed on it. Both lucide
rules remain for the real `lucide-react` DOM, including the allowlisted
`svg.lucide-ellipsis circle` entry.

`toaster` in `components/ui/sonner.tsx` is the mirror case. Sonner neither
defines nor requires that class; the component invents it, hands it to Sonner's
`className` prop, and then anchors its own `group-[.toaster]:` variants on it.
Sonner's actual contract is the `[data-sonner-toaster]` attribute it puts on its
own list element. There is also no mechanism to authorize this kind of
dependency: `turbo/style-allowlist.json` holds CSS selectors, style injections
and vendored files, so a legacy class named in a component's `className` can only
be drained or left in the shrink-only baseline — never allowlisted.

### Toast styling is decided by cascade layers, not specificity

Sonner injects its stylesheet into `document.head` at module load, unlayered.
Unlayered rules outrank every layer, so a `@layer utilities` declaration loses to
`[data-sonner-toast][data-styled="true"]` no matter how specific the variant is.
That is why the toast class string carries `!` on most of its utilities, and it
is why the four that lack it — `bg-popover`, `text-foreground`, `border-border`
and `shadow-lg` — have never applied. Measured on the real Sonner runtime, a dark
toast computes `rgb(255, 255, 255)` on `rgb(23, 23, 23)` while `--color-popover`
is `hsl(20 2.9% 20.2%)`: the panel stays light in Dark. The component also passes
no `theme` prop, so Sonner itself is permanently in its `light` palette. The
`description`, `actionButton` and `cancelButton` entries are inert for the same
reason.

Restoring those declarations is a visual decision, not an equivalence repair, and
it is tracked separately. Marking the four important does fix Dark, but it also
moves the Light foreground, border and shadow, and — because `!important` beats
Sonner's unlayered `:focus-visible` rule — it replaces the toast's focus ring
with the resting shadow. Adopting Sonner's supported `theme` prop instead takes
Sonner's palette rather than the App's popover tokens. Draining `toaster` is
blocked behind that choice, because whichever repair wins rewrites the same class
string.

### The Markdown code-fence copy control

The `copied` contract has been retired. Its three App rules, its two
`third-party-dom-adapter` allowlist entries and both of its consumption sites
are gone, and `CodeBlockCopyButton` now owns the treatment for both fence
shapes: the one the Markdown pipeline marks on every fenced block, and the one
the Mermaid view renders when a diagram's source does not parse.

`copied` is the borrowed-name case above, one step further along: the name is
genuinely the vendor's, and the pinned `@uiw/react-markdown-preview` stylesheet
really does define it, which is why two of its three App rules were allowlisted
as adapters for that renderer's generated DOM. The element is still ours. The
App mounts no part of that renderer — it imports only the stylesheet, and parses
and renders Markdown itself — so every element that ever carried the class was
first-party markup spelling `className="copied"` to borrow the vendored sheet's
absolutely positioned, hover-revealed copy affordance. Authorship of the
element, not authorship of the name or of the rule, is what the boundary asks
about, so this was legacy debt and the two entries are retired with the rules.

The replacement therefore reproduces the vendored declarations as well as the
App's own overrides, because both were load-bearing and only the App's half
could be deleted:

| Retired declaration                                | Owner  | Replacement                                                               |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `visibility: hidden`                               | vendor | `invisible`                                                               |
| `pre:hover` → `visibility: visible`                | vendor | `[pre:hover_&]:visible`                                                   |
| `display: flex`                                    | vendor | `flex`                                                                    |
| `position: absolute; top: 6px; right: 6px`         | vendor | `absolute top-1.5 right-1.5`                                              |
| `cursor: pointer`                                  | vendor | `cursor-pointer`                                                          |
| `padding: 6px`                                     | vendor | `p-1.5`                                                                   |
| `font-size: 12px`                                  | vendor | `text-[12px]`                                                             |
| `transition: all 0.3s`                             | vendor | `transition-[visibility,background-color,color] duration-300 ease-[ease]` |
| `border-radius: 6px`                               | App    | `rounded-md`                                                              |
| `background: hsl(var(--gray-200))`                 | App    | `bg-gray-200`                                                             |
| `color: hsl(var(--muted-foreground))`              | App    | `text-muted-foreground`                                                   |
| `pre:hover .copied:hover` → gray-300 / foreground  | App    | `[pre:hover_&:hover:not(:active)]:…`                                      |
| `pre:hover .copied:active` → gray-400 / foreground | App    | `[pre:hover_&:active]:…`                                                  |

Four of those need stating.

`rounded-md` is exactly the retired 6px: `--radius-md` is `calc(var(--radius) - 2px)` over a `0.5rem` radius. `p-1.5` replaces the shared control's own `p-2` through `cn()`, which is not a change of value — the unlayered vendored `padding: 6px` already outranked that utility, so 6px is what the control has always painted.

`text-[12px]` names the size rather than taking `text-xs`, for the reason the badge batch records: an arbitrary font-size utility emits `font-size` alone, and `text-xs` would add a paired line height the retired declaration never set. `ease-[ease]` is needed for the same kind of reason — a Tailwind transition utility supplies Tailwind's own `--default-transition-timing-function`, while `transition: all 0.3s` left the timing function at its `ease` initial value.

The transition is the one declaration deliberately not reproduced verbatim. This is an auxiliary control revealed by hover, so the rule above applies: name the properties that animate rather than taking `all`. Only `visibility`, `background-color` and `color` ever change on this control, and `visibility` has to stay in the list, because with it the control remains painted for the transition's duration after the pointer leaves and without it the control vanishes instantly. Measured, narrowing the list changes zero pixels in all 28 states and changes exactly one observation, `transition-property`, on the control itself.

The reveal and both interaction fills spell `pre:hover &` rather than reaching for `group-hover:`. The retired rules were unlayered and ungated, so they also fired on a coarse pointer where a tap leaves a sticky hover; the arbitrary variants generate the same unconditional descendant selector. Spelling the ancestor also raises specificity above the shared control's own `hover:` fill, so the two stop racing inside one Tailwind layer.

The hovered fill carries `:not(:active)` because Tailwind decides the order the retired rules decided by source position. Both retired rules had equal specificity and the pressed one came second, so it won while both matched; Tailwind sorts the pressed variant first, so the hovered fill steps aside by selector instead.

`.wmde-markdown pre .copied.active` was dead and is gone with the rest. `CopyButton` never adds an `active` class — it swaps icons from React state — so that branch of the selector list never matched. The vendored sheet's own `.copied.active` rules remain, pinned and inert, because nothing carries the class any more. The `--color-copied-active-bg` overrides the App declared for them are removed with it.

Measured against `main` with the App's own Tailwind compiler in Chromium over CDP, on the ancestor chain captured from the real chat thread page: 28 states — both fence shapes at rest, fence-hovered, control-hovered and pressed, in Light and Dark, on a fine and a coarse pointer — report zero changed pixels and zero computed-style or geometry differences. Negative controls that drop the control's padding, shift its offset by one spacing step and drop the reveal variant report 7,818, 3,579 and 9,164 changed pixels, so the zeros are not degenerate.

### The Mermaid fallback fence

`language-mermaid` is drained. `MermaidDiagramView` renders an ordinary code
block when the parser rejects a fence's source, and that block used to spell
`className="language-mermaid"` by hand to imitate the fence markup the Markdown
pipeline produces. The class had nothing to select: no first-party declaration
matches it, and the pinned `@uiw/react-markdown-preview` sheet's only
`language-` rule is `.wmde-markdown .language-css .token.string`. Nor could
tokens appear under it — the pipeline runs `rehype-prism-plus` with
`ignoreMissing: true` and its common grammar bundle carries no mermaid grammar,
so a mermaid fence is never tokenised on either path. The same component's
`<details>` source block already carried no class, which is the shape the
fallback block now takes. The retirement is therefore an equivalence, with no
utility to replace the class with.

This is the borrowed-name case again, one step simpler than `copied`: the
element is ours, the name is a convention of `marked`'s fenced-code output, and
there is no rule behind it in either sheet. So it was legacy debt rather than a
third-party DOM adapter, and it could only be drained.

`lib/rehype-mermaid.ts` still spells the class, and that use is out of scope
rather than overlooked. It reads the class off a tree it did not author, to
recognise a Mermaid fence before a diagram marker replaces it: `marked` writes
the class for a Markdown fence, and a message carrying raw
`<pre><code class="language-mermaid">` HTML writes it directly. Both are
external DOM contracts being parsed, not first-party styling, so neither the
legacy baseline nor `no-unknown-classes` counts them — the baseline resolves
class attributes and class-helper calls, and the rule reads class attributes
only. The rendered component's markup never re-enters that pipeline, so the
drained attribute and the surviving detector do not meet. Page tests that query
`code.language-mermaid` likewise match pipeline-generated markup, not this
component. Removing the detector's class check would stop rendering
raw-HTML-authored Mermaid blocks as diagrams, which is a product decision with
no current test coverage, and is tracked separately from this drain.

### Markdown card block spacing

The `okou-markdown-card` selector and its consumers have been removed. It never
had a rule of its own: it shared one with `.wmde-markdown p`, so a card slot that
enters the tree as a paragraph and leaves it as a `div` kept the paragraph's 6px
block rhythm. Both consumers in `rich-markdown.tsx` now spell that rhythm as
`my-1.5`, and the vendored selector keeps its half of the split rule as a
`third-party-dom-adapter` entry alongside the fifteen sibling `.wmde-markdown`
spacing selectors that were already allowlisted. `p` was the one missing from
that group precisely because it had been welded to a first-party class.

`my-1.5` is exactly the retired 6px: it emits `calc(var(--spacing) * 1.5)` over
the default `0.25rem`, and neither stylesheet overrides `--spacing` or the root
font size. It emits `margin-block` where the retired rule set `margin-top` and
`margin-bottom`; the App has no vertical writing mode, so the two resolve to the
same physical edges.

The split changes which rule wins for a card at either end of the document, and
it changes it to the same answer. `.wmde-markdown > :first-child` and
`> :last-child` are unlayered and have the same `(0,2,0)` specificity the retired
`.wmde-markdown .okou-markdown-card` had, and they come later in the file, so
they already zeroed the outer margin of a first or last card by source order.
They now win because they are unlayered and `my-1.5` sits in `@layer utilities`.
A card anywhere else matched only the retired rule and now matches only the
utility. All three positions therefore keep the margins they had.

Pixel evidence for this batch was never captured; the equivalence argument
above is the whole of it.

### Chat transcript cards

`ChatCard` in `turbo/apps/platform/src/views/okou-page/components/chat-card.tsx`
owns the surface shared by transcript notice cards, action cards and media
frames. It follows `Badge`'s `useRender` shape, so a caller picks the host
element with `render` and gets no wrapper. It is App-owned rather than shared, because its radius and
shadow read the App-only `--okou-chat-card-*` variables, which the App
stylesheet declares at `:root`.

The border is deliberately `border-[1px] border-gray-400` rather than the shared
`border` hairline and a semantic border token. The retired rule pinned a whole
pixel because fractional borders visibly repaint when card contents resolve, so
a card flickers at its edge as an image or an iframe lands. This migration
preserves that; unifying the transcript's border width and colour with the rest
of the product is a separate visual decision.

The retired rule sat in `@layer components` so a caller's composed `border-*`,
`bg-*` or `hover:*` utility could still outrank it — the browser session card's
hover and selected borders are the only consumers that ever needed it. A
component removes that arrangement rather than reproducing it: `cn()` merges the
base with the caller's `className`, so a conflicting base utility is dropped
instead of being outranked, and no layer ordering is involved. Measured on a
reconstructed ancestor chain, the card's resting, hover, selected and
selected-hover borders are identical before and after, and a control that drops
the hover override moves 5,236 pixels, so the override is load-bearing rather
than inert.

The radius and shadow use `rounded-[var(…)]` and `shadow-[var(…)]`, matching the
19 call sites that read the page-level `--okou-card-*` siblings the same way.
Tailwind's shadow utility composes `--tw-shadow` in either spelling, so the
serialized `box-shadow` carries four fully transparent placeholders the retired
shorthand did not. The painted result is identical; a comparison should
normalize those placeholders away rather than treat the string as the contract.
One consequence is that `tailwind-merge` cannot classify an arbitrary
`shadow-[var(…)]` as a box-shadow and so will not drop it for a caller's own
`shadow-*`. No consumer overrides the shadow. Registering `@theme` tokens and a
named `shadow-*` scale in `cn()` would restore that, and is the documented route
if a consumer ever needs it.

The `okou-chat-card` and `okou-chat-frame` selectors and their consumers have
been removed.

Five of the eighteen consumers never rendered that treatment. They live in the
artifact preview dialog, and `DialogContent` portals to `document.body`, so the
`.okou-app` ancestor `.okou-app .okou-chat-card` requires was never present and
the rule painted nothing there. Measured on the rendered page before the change,
all five report `closest(".okou-app") === null` while a transcript card reports
`true`. Their class names were therefore deleted rather than replaced: the
container keeps the treatment-free appearance it actually had. Giving the
artifact preview a card surface remains a separate visual decision: measured on
the portaled surface, adopting the shared base there would change 734,605
pixels. It is no longer blocked by scope. Those two custom properties were
declared on `.okou-app` at the time, so a `ChatCard` rendered in the portal
resolved to a square, shadowless border; they now sit at `:root` and a portaled
card would resolve both.

`okou-chat-frame` had exactly one consumer, that dialog's video stage, so it
carried no live declaration anywhere.

### Chat thinking states

The `okou-thinking-enter`, `okou-thinking-spinner`, `okou-thinking-spinner-frame`
and `okou-chat-skeleton-reveal` selectors and their consumers have been removed.
`okou-thinking-spinner-frame` carried no declarations, so its removal is a pure
class deletion. The four selectors had six consumption sites, three of them
`okou-thinking-enter`, and all six live in `chat-thread-page.tsx`; the keyframes
stay, because keyframes are not class selectors.

Each retired `animation` shorthand becomes an `--animate-*` theme entry, so the
consumers reach the motion through `animate-thinking-in` and
`animate-chat-skeleton-reveal` instead of respelling a shorthand. The spinner
keeps `animate-spin` and overrides only its duration, through
`[animation-duration:1.4s]` beside `will-change-transform`.

One computed-style difference is intended and carries no pixels. Under
`prefers-reduced-motion: reduce` the spinner's `animation-duration` was `1.4s`
before and is `0s` after. The retired rule sat outside every layer, so it kept
setting a duration even once `motion-reduce:animate-none` had cleared
`animation-name`; as a utility, the duration is now cleared with the rest of the
shorthand. `animation-name` is `none` on both sides, so the property is inert
and all 18 reduced-motion theme states report zero changed pixels.

Measured against `main` with the App's own Tailwind compiler in Chromium over
CDP, on the real ancestor chain (`.okou-app` shell, chat `<main>`, message list,
thinking wrapper, response line, leading-icon span): 288 comparisons — 18 theme
states (the default palette plus the eight gradient palettes, each in Light and
Dark) across fine-pointer DPR 1 and DPR 2, coarse pointer, and reduced motion,
with the animations paused at 0/200/400/700/1050 ms. Zero changed pixels, and
the only observation difference is the inert reduced-motion duration above.
Every capture also asserts that both sides report the same number of running
animations, because a finite animation that ends is dropped from
`getAnimations()` and would otherwise be compared at a different phase.

The three-block loader is not part of this batch. `okou-blocks` was retired by
the separate removal of the chat thinking spinner switch, which deleted the
loader, its colour state and its keyframes outright; the rotating mark is now
the only thinking indicator, so these states are the online-visible path.

`okou-shimmer-text` was scoped out of that batch and has since been drained on
its own terms. Its gradient has six colour stops, and Tailwind's own gradient
utilities interpolate in oklab and compose from three positions, so no `bg-*`
utility can express it and the inline `bg-[linear-gradient(…)]` form runs to 229
characters for one class. The decision that batch deferred was between that and
an App-owned token; the token won.

`--background-image-shimmer-text` is an `@theme inline` entry, so `bg-shimmer-text`
emits the gradient with its `--muted-foreground` and `--foreground` references
intact and each theme still resolves them on the element. `--animate-shimmer`
joins the `--animate-*` entries beside it on the same contract, and the
`okou-shimmer` keyframes stay in the stylesheet, because keyframes are not class
selectors. The remaining declarations are ordinary utilities on `ShimmerText` in
`chat-thread-page.tsx`, which already existed as a component and needed no new
wrapper.

Two of them need stating. `[background-size:200%_100%]` is an arbitrary property
rather than `bg-size-*`, matching the effort slider's `[background-size:…]`
beside its own aurora tokens. And `[-webkit-background-clip:text]` stays beside
`bg-clip-text` because Tailwind emits only the unprefixed property: its default
targets do not need the prefix, but the retired rule declared both, so keeping it
is the no-change choice. Chromium treats the two as aliases, so no measurement
here can separate them — dropping either one leaves both computing to `text`.
Removing the prefixed declaration is a browser-support decision, not part of this
drain.

### The standalone PWA fixed cover

The `okou-pwa-fixed-cover` selector and its consumers have been removed. It was
one declaration — `bottom: calc(-1 * var(--sab))` inside
`@media (display-mode: standalone)` — on the mobile drawer scrim and on the
artifact-preview dialog backdrop. Both are `fixed inset-0`, and a fixed cover is
clipped by the visual viewport, so in a standalone PWA it stops short of the
bottom safe inset; extending `bottom` paints it to the physical edge while the
drawer's own content keeps its safe-area padding. Each consumer now writes
`[@media(display-mode:standalone)]:bottom-[calc(-1*var(--sab))]`.

Tailwind has no `display-mode` variant, and this is a genuine environment
condition rather than a token decision, so it stays an arbitrary variant over an
arbitrary value — the shape the existing `[@media(hover:hover)]:` call sites
already use. The utility has to win against the `inset-0` on the same element,
and it does: Tailwind emits the `inset` shorthand before the `bottom` longhand
inside `@layer utilities`, and `cn()` keeps both, because a modifier-prefixed
`bottom-*` never conflicts with an unprefixed `inset-0`.

Measured against `main` with the App's own Tailwind compiler in Chromium over
CDP: 216 states per pointer mode — two fixtures, the shell with its drawer and
scrim and the portaled dialog backdrop, across the default palette plus the
eight gradient palettes in Light and Dark, at 1440x900, 390x844 DPR 2 and 767px,
each with and without a standalone display mode. Zero changed pixels and zero
computed-style or geometry differences in both the fine-pointer and
coarse-pointer runs.

Two details make those zeros meaningful. `--sat`/`--sar`/`--sab`/`--sal` come
from `env(safe-area-inset-*)` and resolve to `0px` in a desktop Chromium, which
would make every inset under test measure zero and report a false no-change, so
the harness injects non-zero insets on both sides and asserts them at every
capture. And `display-mode` cannot be emulated: in Chromium 152
`Emulation.setEmulatedMedia` accepts `{name:"display-mode",value:"standalone"}`
without error while `matchMedia` still reports `browser`, for features-only,
with `media:"screen"`, with `media:""`, and for value `fullscreen`. A window
launched with `--app=<url>` against a served web app manifest reports a real
standalone display mode, so the standalone states run there rather than against
a substituted media condition.

A pixel diff alone also cannot accept this rule, because its whole effect is
paint below the visual viewport: on-screen pixels are identical whether it
applies or not. Geometry is its channel, and the negative controls check both
channels separately — dropping the migrated bottom extension moves the scrim and
backdrop boxes without changing a pixel, while dropping their background fills
changes millions of pixels.

The `okou-mobile-sidebar` and `okou-mobile-fixed-safe-area` selectors and their
consumers have been removed. They sat together on the mobile drawer `aside` and
are now utilities on it, which is the same answer the drawer's own scrim already
carries: `sidebar-layout.tsx` spells
`[@media(display-mode:standalone)]:bottom-[calc(-1*var(--sab))]` inline, and so
does the lightbox overlay. The batch had been recorded `blocked` on a choice
between inlining, a shared safe-area decision and a drawer-surface component;
inlining is what the sibling element next to it was already doing.

The `::before` layer exists for exactly one case. The `aside` already carries
`bg-sidebar`, so that fill is invisible wherever the element's own box is: its
only visible work is the standalone-PWA extension below, which paints the
sidebar colour into the home-indicator area while the drawer's content keeps its
safe-area padding. `isolate` is what keeps the `-z-1` layer inside this element
instead of letting it fall behind the page.

The four-value padding is `max-md:p-safe`, the utility the browser-session cover
registered, rather than the four-value bracketed arbitrary value this note
previously estimated; that is what holds the class list to 458 characters
instead of 499. Two bracketed values remain, both on the `::before`.

`max-md` is still not an exact restatement of the retired condition. Tailwind
emits `@media (width < 48rem)` while the rule stopped at `max-width: 767px`, so
a fractional viewport width strictly between 767px and 768px newly takes the
padding. Every integer width agrees, measured at 767 and 768; the element
already gates its whole fixed-drawer geometry on `max-md`, so that width is
where the two spellings disagree today and aligning them is the smaller
surprise.

### The onboarding workflow diagram canvas

The diagram is a fixed 614x470 illustration scaled to 0.6, so its geometry was a
block of coordinate variables plus absolutely positioned rules. Twelve of its
selectors have been removed and their declarations now live as Tailwind
utilities on the component: the wrapper, the dotted grid, the connector-line
SVG, the travelling beam, the vertical control, the node base and its three
positions, the icon stack host, the avatar host and the action copy.

`owf-diagram` is deliberately still on the canvas element, reduced to the 25
shared coordinate variables that the remaining tile and dot rules read. A class
kept only as a variable carrier is not an exception for business styling: it
contributes no geometry, and it retires with those readers. Inlining each
variable into the rules that read them was not an option, because the ratchet
compares whole declarations and would score a rewritten value as new
first-party CSS.

The beam registers `--animate-owf-beam-flow` as an `--animate-*` theme entry,
the same form the thinking states use, and its keyframes stay in the stylesheet.
Its retired `prefers-reduced-motion` override did two things — cancel the
animation and dim the beam from 0.92 to 0.35 — so both belong to
`motion-safe:`: the element carries `opacity-[0.35]` with
`motion-safe:opacity-[0.92] motion-safe:animate-owf-beam-flow`. A
`motion-reduce:` utility would have depended on emission order to win.

The beam gradient, both of its drop shadows and the two literal brand strokes
keep their exact values in arbitrary utilities. Tailwind's gradient utilities
interpolate in oklab, and this gradient has five stops with literal `rgba()`
colors. The grid's radial gradient likewise spells
`hsl(var(--gray-500)/0.55)` rather than a ramp utility, because the retired rule
named that alpha.

Type maps onto the shared scale exactly: the node labels' 12px/16px is `text-xs`,
the action title's 16px/24px is `text-base`, and its description's 14px/20px is
`text-sm`, so no arbitrary font size survives. The description keeps
`text-ellipsis` beside `line-clamp-2`, which the retired rule declared and the
utility does not imply.

One inherited cascade is preserved rather than corrected. The retained
`.owf-diagram-icon-box img` rule sizes every image inside a tile at 34px and,
being unlayered, outranks the `size-full` utility on the Okou avatar image, so
that avatar renders at 34px inside its 64px host today. The canvas batch keeps
that behaviour; changing it is a visual decision for the tiles batch.

Page tests select the source node and source dot through
`data-slot="onboarding-diagram-source-node"` and
`data-slot="onboarding-diagram-source-dot"`, which carry no styles.

### Illustration strokes

`--border-width-illustration` (1px) and `--border-width-illustration-marker`
(1.5px) are App-layer tokens for artwork that is drawn rather than chrome. They
are a different decision from `--default-border-width`, not a competing value
for it, in the same way `border-2` is: the hairline decides how thick _a
border_ is, while an illustration owns the weight of its own outlines. Both are
identical in Light and Dark, because a stroke weight is not a theme value.
Consumers read them through `border-(length:--border-width-illustration*)`
beside `border-solid`, the same shape `Card` uses for
`--border-width-surface`.

Their scope is artwork, and nothing else. A control, surface, card, input,
divider or any other piece of product chrome takes the shared hairline; reach
for these only for a drawing whose strokes are part of the picture. They live
in the App token layer because the onboarding diagram is their only consumer
today, and they promote to `@okouai/ui` when a second product surface draws
with them. Adding a third weight is a token change, not a call-site decision.

The first consumers are the onboarding diagram's tiles: the icon box, the
connector stack items, the overflow badge and the two action cards take
`--border-width-illustration`, and the six waypoint dots take the marker
weight. Those tiles otherwise use the semantic `bg-card` fill and `border-border`
stroke, `rounded-surface` for the action cards and the artwork's own
`shadow-[0_12px_30px_-18px_rgba(0,0,0,0.5)]` lift.

`white` is not white here. `--color-white` is `hsl(var(--white))`, a
theme-flipped token that resolves to a near-black in Dark, so the dots and the
overflow badge spell the literal `#ffffff` the retired rules named. Measured,
`border-white` moved 147 pixels of ring in Dark and none at all in Light, which
is exactly the shape of a defect a Light-only check would have shipped.

## Exception boundary

Only two exception kinds exist:

- `global-environment` covers document-level browser or theme state that cannot be represented by a component utility.
- `third-party-dom-adapter` covers DOM or isolated documents whose element classes are owned outside the business component.

Hosted Clerk authentication does not use a third-party DOM adapter. It stays on
Clerk's public appearance API under the narrower rules in
[Clerk customization](./clerk-customize.md).

Every exception identifies the exact file and selector or injected-style fingerprint, its owner, rationale, and removal condition. Third-party adapters also identify their upstream DOM owner. A styling convenience, missing utility, or existing first-party convention is not an exception. Vendored CSS is pinned by exact path and SHA-256 rather than by a directory-wide ignore.

## Shrink-only legacy state

`turbo/style-legacy-baseline.json` records current first-party selector declarations as normalized CSS AST atoms, including nested selector ancestry, conditional at-rules, `@scope` roots and limits, and `@apply` contents. A class-qualified scope also freezes its `:scope`, `&`, and element-selector declarations; scope boundaries participate in exact baseline and adapter matching. Legacy class dependencies are counted at their consuming attributes or calls, resolving local constants, imported aliases, and re-exports. Reusing an existing constant in another consumer is a new dependency. The baseline also fingerprints existing inline or injected styles that are not permanent adapters.

The baseline is not an allowlist and has no command that expands it. A new selector, a changed declaration, a new use of an existing legacy class, or a new style injection fails lint. Removing legacy state intentionally makes the baseline stale; `pnpm lint:style:prune` only intersects the baseline with current source and refuses to authorize growth. Pre-commit compares the baseline with `HEAD`, while CI compares it with the pull request or merge-queue base SHA, so manually editing source and baseline together cannot bypass the ratchet.

Commands run from `turbo`. An invalid Git reference, unreadable baseline, or malformed JSON fails with a nonzero exit status and a pointer to this guide. Only a reference commit genuinely predating the baseline file permits its initial introduction. That bootstrap case applies to local/CI repository history, not production version compatibility; once the target base contains the baseline, the ratchet is mandatory.

## Enforcement and feedback

### Dialog viewport ownership

`DialogContent` owns the Base UI viewport and popup. Windowed dialogs are
centered inside the four safe-area insets plus a 24 px gutter. Fullscreen
dialogs paint to the viewport edges while their content and close control stay
inside the safe-area insets. The environment values come from the existing
`--sat`, `--sar`, `--sab`, `--sal`, and `--okou-viewport-height` properties;
the shared primitive also works with native `env()` insets outside Platform.

Callers select `maxWidth`, `smMaxWidth`, `height`, and `mode`. The popup fills
the available safe width and is capped by `maxWidth` (default `lg`);
`smMaxWidth` changes that upper bound only from the shared `sm` breakpoint.
Width caps never set a fixed width or determine height. Preserve existing
breakpoints and units when migrating: `sm:max-w-[480px]` becomes
`smMaxWidth={480}`, and `max-w-[25rem]` becomes `maxWidth="25rem"`.
The artifact preview uses `maxWidth={1440} height={1000}`. Every variant is
capped by the available viewport, so increasing a cap cannot increase the
safe boundary.

The popup does not accept `className`, `style`, or `render`. Use
`contentClassName` for the inner layout and `DialogBody` for a scrolling body
below a fixed header. `contentClassName` remains subject to the style policy.
The shared inner container protects vertical scrolling even when caller layout
classes include `overflow-hidden`. Short panels must keep their footer actions
reachable by scrolling; clipping the popup to its safe boundary is not enough.
Use `showCloseButton` instead of CSS selectors that hide the close control.
Business code must import the shared dialog rather than Base UI's dialog
primitives; ESLint enforces this boundary. Preserve Base UI's focus, nested
portal, outside-press, and animation-completion ownership when changing it.

Run the complete check from `turbo`:

```bash
pnpm lint:style
```

The check has three layers:

1. The repository policy compares CSS AST atoms, legacy class dependency counts, injected-style fingerprints, exact adapter entries, and vendored file hashes.
2. `@eslint/css` parses first-party CSS with Tailwind v4 syntax and disallows inline ESLint configuration for this check.
3. `eslint-plugin-better-tailwindcss/no-unknown-classes` validates component class strings against the real App Tailwind entry point while accepting only the recorded legacy tokens.

CI runs this as the independent required `lint-style` job. The pre-commit hook runs the fast repository policy so the most actionable boundary failures are returned before push. Both policy diagnostics and the full lint command's failure output direct contributors to `docs/styles.md` for the style guide. The full command keeps a failing exit status for policy, CSS, Tailwind, or test failures.

When a style check fails, read this guide and replace business styling with the appropriate Tailwind utilities and registered tokens. Prune the baseline when legacy code has been removed. Do not suppress the check or add a business styling exception to make it pass.

## App palette previews

`bg-palette-anchor bg-palette-gradient` renders the color-theme anchor and its
fixed companion gradient. These App-owned domain utilities use `@theme inline`
so each element resolves its own `data-color-theme` anchor/companion instead of
inheriting the selected document palette. The 135-degree gradient and 52% sRGB
midpoint are identical in Light/Dark; consumer geometry stays at the call site.
