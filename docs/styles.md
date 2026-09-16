# App style guide

The App design system has one component-facing styling API: Tailwind utilities.
Business components in `turbo/apps/platform` and shared components in
`turbo/packages/ui` must compose utilities directly, normally through
`className`, `cn()`, or `cva()`.

First-party CSS class selectors are not a second component API. New CSS modules,
`<style>` elements, runtime stylesheet injection, and CSS-in-JS are subject to
the same boundary because they otherwise bypass Tailwind and the token system.

## Where to look

Building something:

| You are doing this                                        | Read                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawing a border, a rule or a separator                   | The hairline tokens in [Sources of truth](#sources-of-truth), then [Horizontal hairline rules](#horizontal-hairline-rules) or [The all-round hairline](#the-all-round-hairline) |
| Building a card, panel or page surface                    | [Page surfaces](#page-surfaces)                                                                                                                                                 |
| Building a badge, tag or chip                             | [Inline badges](#inline-badges)                                                                                                                                                 |
| Building a button or a select                             | [Neutral button and select variants](#neutral-button-and-select-variants)                                                                                                       |
| Building a dialog, sheet or scrolling body                | [Icon controls and dialog bodies](#icon-controls-and-dialog-bodies), [Dialog viewport ownership](#dialog-viewport-ownership)                                                    |
| Building a card inside the chat transcript                | [Chat transcript cards](#chat-transcript-cards)                                                                                                                                 |
| Building the composer, or a surface that stands in for it | [The composer card surface](#the-composer-card-surface)                                                                                                                         |
| Adding a scroll area                                      | [Chat scrollbars](#chat-scrollbars)                                                                                                                                             |
| Adding motion, or handling reduced motion                 | [Animated layers](#animated-layers)                                                                                                                                             |
| Styling on an ancestor's hover or focus                   | [Ancestor state without the hover media query](#ancestor-state-without-the-hover-media-query)                                                                                   |
| Reproducing an exact color or gradient                    | [Literal colors and gradients](#literal-colors-and-gradients)                                                                                                                   |
| Spacing a control against the top edge of its surface     | [Top-edge clearance](#top-edge-clearance)                                                                                                                                       |
| Drawing artwork rather than chrome                        | [Illustration strokes](#illustration-strokes)                                                                                                                                   |
| Choosing a page layout or covering the viewport           | [Page layouts](#page-layouts)                                                                                                                                                   |
| Adding a token or a variant                               | [Token and variant governance](#token-and-variant-governance)                                                                                                                   |
| Adapting third-party or generated DOM                     | [Exception boundary](#exception-boundary), [Third-party attribution of borrowed class names](#third-party-attribution-of-borrowed-class-names)                                  |
| A style check failed                                      | [Enforcement and feedback](#enforcement-and-feedback)                                                                                                                           |

Changing one of these surfaces — read its note first, because each one records a
cascade or environment constraint that is not obvious from the markup:

| Surface                                                   | Note                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Chat message bubble, or a Markdown frame inside one       | [Chat message bubbles](#chat-message-bubbles)                                                                               |
| Chat thinking indicator, skeleton or shimmer              | [Chat thinking states](#chat-thinking-states)                                                                               |
| Markdown card slot                                        | [Markdown card block spacing](#markdown-card-block-spacing)                                                                 |
| Markdown code fence copy control                          | [The Markdown code-fence copy control](#the-markdown-code-fence-copy-control)                                               |
| Mermaid diagram fallback                                  | [The Mermaid fallback fence](#the-mermaid-fallback-fence)                                                                   |
| Toast                                                     | [Toast styling under an unlayered stylesheet](#toast-styling-under-an-unlayered-stylesheet)                                 |
| Table header                                              | [Table header rules and the global scrollbar treatment](#table-header-rules-and-the-global-scrollbar-treatment)             |
| Sidebar copy, nav rail or expanded drawer                 | [Sidebar copy and nav chrome under the gradient color themes](#sidebar-copy-and-nav-chrome-under-the-gradient-color-themes) |
| Workspace pane background                                 | [The workspace canvas](#the-workspace-canvas)                                                                               |
| Any card radius or shadow token                           | [Card geometry at the document root](#card-geometry-at-the-document-root)                                                   |
| Mobile drawer, scrim or a fixed cover in a standalone PWA | [The standalone PWA fixed cover](#the-standalone-pwa-fixed-cover)                                                           |
| Onboarding workflow diagram                               | [The onboarding workflow diagram canvas](#the-onboarding-workflow-diagram-canvas)                                           |
| Color-theme preview swatch                                | [App palette previews](#app-palette-previews)                                                                               |

## Final state

The goal is zero first-party CSS class selectors for business styling.
Preventing growth is an interim guardrail, not completion of this goal.

- Business and shared UI components use Tailwind utilities and semantic
  component variants. They neither define nor depend on first-party styling
  classes, including classes that wrap `@apply`.
- First-party selectors, their class dependencies, and component-owned inline or
  injected styles are eliminated.
- Runtime behavior and tests use semantic roles, accessible names, refs,
  `data-*` hooks, or documented component slots instead of querying styling
  classes.
- Remaining handwritten CSS is limited to centrally managed design variables and
  tokens, explicitly allowlisted global environment rules, and explicitly
  allowlisted third-party DOM adapters. These exceptions do not authorize
  business styling.
- Every environment or adapter exception has an exact scope, owner, rationale,
  and removal condition. Third-party entries also identify the upstream DOM
  owner; vendored stylesheets are pinned to their exact content hash.
  Directory-wide ignores and class-prefix exemptions are not allowed.
- The design system has a documented ownership chain from primitive variables to
  semantic tokens, Tailwind utilities, and component variants, including naming,
  theme mapping, introduction, change, deprecation, and review. Components reuse
  that contract instead of creating a parallel variable or token registry.
- Lint and agent instructions enforce the same boundary. Failures direct
  contributors to this guide and the underlying fix; business selectors cannot
  be authorized by disabling lint, expanding a baseline, or adding an allowlist
  entry.

Passing the current lint establishes compliance with the guardrail.

## Sources of truth

| Concern                                         | Source of truth                                                                    | Consumer contract                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primitive and runtime theme values              | `turbo/packages/ui/src/styles/globals.css` under `:root` and `[data-theme="dark"]` | Referenced through semantic variables, not directly from components          |
| Tailwind design tokens                          | Shared `@theme` definitions in `turbo/packages/ui/src/styles/globals.css`          | Utilities such as `bg-background`, `text-muted-foreground`, and `rounded-lg` |
| App-only semantic tokens                        | `@theme` in `turbo/apps/platform/src/views/css/index.css`                          | Named utilities for an App domain concept; promote to UI when shared         |
| Component variants                              | TypeScript component APIs and `cva()` definitions                                  | A bounded set of semantic props and Tailwind utility combinations            |
| Global environment and generated DOM adaptation | `turbo/style-allowlist.json`                                                       | Infrastructure-only exception with exact selector or injection fingerprint   |

Token names describe meaning rather than a page or component. A reusable
interaction state, surface, foreground, border, radius, or typography decision
belongs in the shared token layer. A product-specific data visualization
category may remain App-only until another product consumes it. Theme
differences are assigned at the primitive/runtime variable layer; components
continue to use the same semantic utility in both themes.

Components must not introduce local CSS variables as an alternate token
registry. A runtime value that is genuinely computed by the component may use a
narrowly named custom property as data, while its visual semantics still come
from Tailwind utilities and registered tokens.

One hairline serves the whole product. `--default-border-width` in the shared
`@theme` is 0.5px, and Tailwind's bare `border`, `border-t`, `border-x`,
`divide-y`, and their siblings all read it, so a component asks for "a border"
and the system decides how thick it is. Components must not hand-write a width:
an arbitrary width such as `border-[0.7px]`, or a literal width inside a `style`
prop, is a second registry for a decision this token already owns, and the two
diverge wherever the device scale is odd: at scale 3 a hand-written `0.7px`
paints two device pixels where the token paints one. `border-0` and the
deliberate emphasis widths such as `border-2` stay available, because they
express a different decision rather than a competing value for the same one.

This is a real hairline, not a rounding no-op. On a 2x display 0.5px paints one
device pixel where 1px paints two, so every bare border carries half the ink it
used to; layout is unaffected, because the used value is still rounded to whole
pixels. Colour has to carry what the width no longer does, which is why
`--border` sits one stop darker than the surface ramp's lightest step:
`gray-200` was calibrated for a 1px line and stops reading on a near-white card
at half the thickness.

A third token covers the case neither of those can. `--border` and `--divider`
are both measured against the page canvas, and `--divider` is pinned to
`gray-200` in every theme; the gradient color presets also keep `gray-200` for
`--border`. The filled surfaces that carry their own rules are `gray-200`
themselves, so under those presets a rule reading either neutral token resolves
to its own background and disappears. `--border-on-fill` is one step off that
fill rather than off the canvas. Use `border-border-on-fill` for a border or
rule drawn on a filled surface, and keep `border-border` for one drawn on the
canvas or a card. It equals `--border` in the neutral themes, so adopting it
changes nothing there.

Borders and rules are separate decisions with separate tokens. `--border` is for
real borders, which follow `--default-border-width`. `--divider` is the lightest
neutral rule — separators, `h-px` / `w-px` hairlines painted as backgrounds, and
resting rail ticks. Those are sized explicitly, so they never lost thickness to
the border hairline and must not inherit its compensating darkening. Use
`bg-divider` for a painted rule and `border-border` for an actual border; do not
reach for a raw ramp stop such as `border-gray-200` for either, because that
bypasses both decisions.

Color-theme presets in the App stylesheet share their anchor and companion
colors between picker swatches and workspace ambience. Daydream uses cool blue
and violet, while Cotton sky uses pastel pink and blue. Each preset's hue and
ring values keep semantic surfaces, selected states, and focus indicators
aligned with that palette in Light/Dark.

When `GradientColorThemes` is enabled on the document, each preset's HSL primary
value supplies both its anchor color and the shared `--primary` token. Primary
actions, including portaled dialog buttons, immediately use that fill and the
preset's contrast-checked `--primary-foreground` in Light/Dark. Hover and
pressed fills blend the anchor toward its companion using the existing
filled-state alpha tokens. Disabled buttons retain the shared opacity treatment.
Removing the document's color-theme attributes restores the shared Amber primary
tokens.

The preset also supplies `--primary-400`, because one filled control reads that ramp stop rather than `--primary`. The checked `Switch` track takes 400 so it sits one step darker than the brand stop, which is what keeps a 44x24 fill reading as a fill on a near-white card; `Checkbox` and `Radio` are small enough to take `--primary` directly. A preset has a single anchor and no ramp, so pointing the stop at that anchor puts the checked toggle on the same fill as every other filled control instead of leaving it Amber under all eight palettes. This is the same move the presets already make on the gray ramp, and it is confined to the one stop with a consumer: `--brand-subtle`, `--brand-text`, and `--brand-text-hover` keep reading the Amber ramp, because the brand mark is not palette-driven.

Auxiliary controls and previews revealed by hover or keyboard focus change
opacity immediately. Do not add opacity transitions to message actions, sidebar
controls, card overlays, or similar contextual affordances; temporary
compositing layers can cause nearby content to flicker in Safari. Preserve their
layout, focus visibility, touch behavior, and pointer-event rules. When other
properties still animate, name those properties instead of using
`transition-all`. This does not remove loading or popup lifecycle animations.

## Token and variant governance

New tokens must represent a reusable semantic decision, have a documented
consumer contract, and define their light and dark theme behavior in the
canonical stylesheet. Shared tokens and variants belong to `@okouai/ui`;
App-only tokens belong to the App token layer. A new alias for one component's
hard-coded values is not a token contract.

Token and variant changes are reviewed at their owning layer together with
affected consumers and theme behavior. A rename or semantic change must update
those consumers; deprecated names are removed when their consumers have
migrated, rather than being copied into component-local registries. A change to
ownership, naming, or theme mapping must update this guide in the same PR.

Large editable surfaces use `border-surface-focus` to emphasize their existing
border on focus: neutral gray in light themes and muted amber in dark themes.
Keep the border width constant across interaction states. A shadow-only focus
overlay may fade through opacity, but must not duplicate the surface border or
depend on a negative inset to align its edge. The chat composer uses the default
`border` width for its surface and connector circles; intentional badge overlap
remains independent of border geometry. `data-slot="chat-composer-card"`
identifies the editable card for keyboard positioning and page tests.

The composer's focus overlay is `--okou-composer-focus-veil`. It is a runtime
theme value, so it is owned at `:root`: `signals/theme.ts` writes the theme
attributes onto the document element, and document scope keeps the token
available to any surface that needs it, including portaled ones. Light carries a
neutral veil, dark carries none, and the gradient themes tint it with the
canonical state layer. Each override keys off `[data-theme="dark"]` and
`[data-gradient-color-themes]` alone and wraps the theme test in `:where()`, so
it stays at the specificity of the rule it refines and source order decides
between them. Do not reach for the paired `.dark` class here: a class in the
selector registers a new first-party class-selector declaration and fails the
shrink-only baseline. The two document-level theme selectors that do spell it
are `global-environment` entries in `turbo/style-allowlist.json`, not a
precedent for a new rule.

A focus overlay is also sized to the space its surface actually has. The
composer sits 16px above the workspace pane's bottom edge, so the veil's offset
and blur must bring its falloff back to the surface inside that gap. An overlay
still painting when it meets a clipping ancestor or the pane edge ends in a
visible straight seam instead of fading out, and the gap is not a place to
absorb an arbitrarily wide shadow.

Standalone selectable controls use the shared `ToggleButton` and its required
`selected` prop. Its default `inline` layout keeps compact icon/text choices;
`layout="tile"` fills a grid cell with centered text and 12px horizontal / 10px
vertical padding for Agent profile Tone choices. It retains native button/ref
behavior and owns `aria-pressed`, the selected primary treatment, focus ring,
and disabled appearance. The shared `control-surface` and `control-border`
colors map to the runtime gray-50 and gray-400 ramps in both light and dark
themes, including palette overrides. `bg-state-hover-overlay` layers the
existing hover state over an opaque fill. The toggle variant keeps this
overlay's unconditional `:hover` behavior for touch compatibility; it preserves
the existing media-aware text hover utility.

`Button` represents an action; `ToggleButton` represents a persistent pressed
state. Both render through the internal `ButtonBase` in `button-base.tsx`, which
owns the Base UI button primitive, ref forwarding, render/asChild composition,
native-title handling and optional tooltip. Their typography, radius and focus
styles also share one base definition. Dimensions, icon sizing, transitions and
disabled appearance remain owned by each styled control. `ToggleButton` keeps
the native button and `onClick` contract; it does not manage state or change
group keyboard behavior. Single-value settings keep a selection when the active
choice is activated again. Use the existing `SegmentControl` for a new radio
group that needs group-level keyboard navigation.

Both buttons keep `showTooltip` off by default. Enabling it requires an
`aria-label`, which also supplies the tooltip content; the native `title` is
removed to avoid duplicate hints. The shared tooltip supports disabled triggers
and preserves full-width tile layout. Visible labels and essential explanations
remain available without hovering.

## Component contracts

A component owns its own utilities. Reach for the component rather than
restating its treatment, and keep layout, stacking and container context at the
call site.

### The composer card surface

`Card` from `@okouai/ui` takes `surface="composer"` for the composer card and
the two surfaces that sit in its place: the service-status notice and the shared
thread's claim prompt. The variant carries the fill, radius, border, shadow, the
focus border transition and the `after` veil layer; callers keep layout,
stacking and container context, which is why the composer still spells
`@container/composer z-10` itself.

It is a `cva` variant on the component rather than an exported class string,
because a class constant is not a component API: a caller can reorder it against
its own utilities, and nothing types which surfaces may take it. `surface`
defaults to `default`, so an unannotated `Card` is unchanged. The variant reads
the App's `--okou-card-shadow` and `--okou-composer-focus-veil` from the shared
package, the way `DialogContent` reads `--okou-viewport-height`.

### Page surfaces

`surfaceVariants` from `@okouai/ui` owns the shared page-surface treatment. Use
it on the existing native element, or pass its classes to `Card`; it does not
add a wrapper or change button, form, link, scroll, or overflow semantics. Its
`className` option composes layout utilities. `radius` is `standard` by default
or `compact`; `interactive` opts a whole surface into the pointer hover overlay
and defaults to `false`. A surface containing separate interactive children can
keep the default treatment.

| Decision        | Shared token / utility                                    | Theme contract                                                                                       |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fill            | `bg-card`                                                 | Existing semantic card fill in each theme                                                            |
| Border          | `--color-surface-border`, `--border-width-surface`        | Gray 400 at the shared `--default-border-width` hairline; the browser rounds for its device scale    |
| Radius          | `rounded-surface`, `rounded-surface-compact`              | 1.25rem and a fixed 12px respectively in every theme                                                 |
| Elevation       | `shadow-surface` via `--surface-shadow`                   | Neutral lift in Light/Dark; the gradient theme uses the canonical state-layer hue with reduced alpha |
| Pointer overlay | `bg-state-hover-overlay`                                  | The shared interaction-state overlay painted above the opaque card fill                              |
| Transition      | `transition-[background-color] duration-150 ease-surface` | Background color only, 150ms, CSS `ease`                                                             |

The variant uses `border-(length:--border-width-surface)` so class merging
recognizes the border width independently of its color. Shared `cn()` registers
the custom radius and shadow scales with `tailwind-merge`, keeping composition
with existing UI primitives consistent with Tailwind generation. Register new
named scales there when the class merger cannot otherwise identify their
property group.

The pointer overlay reuses the shared `bg-state-hover-overlay` token rather than
declaring a surface-specific one, so one interaction-state decision keeps one
owner. Like the choice variant, it applies through `[&:hover]` to preserve the
existing touch-browser hover contract as well as pointer hover, and it does not
replace the card fill with a translucent background. Radius, border, shadow, and
transition decisions belong to this variant; use layout utilities for padding,
size, alignment, and overflow.

Integration and connector tests scope controls through the documented
`data-slot="integration-card"`, `data-slot="connector-card"`,
`data-slot="badge"`, and `data-slot="sidebar-thread-title"` component
boundaries. These slots carry no styles; tests must not locate surfaces through
utility or legacy class names.

The `--okou-card-*` variables are read directly by page-level surfaces — the
queue drawer's cards, the mail draft card, the onboarding pickers, and the
composer variant. They are not a supported API for a new surface; reach for
`surfaceVariants` instead. The chat transcript card reads its own
`--okou-chat-card-*` siblings.

### Inline badges

`Badge` from `@okouai/ui` owns the shared inline badge and tag treatment: role
labels, status pills, version chips, and diagnostic key/value chips. It renders
a `span`; pass `render={<code />}` for another host element. It adds no wrapper
and takes no size or tone props.

| Decision    | Shared token / utility                        | Contract                                                                                  |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Fill        | `bg-gray-0`                                   | The neutral base of the gray scale in each theme                                          |
| Border      | `border`, `--color-surface-border`            | Gray 400 at the shared `--default-border-width` hairline                                  |
| Radius      | `rounded-md`                                  | One radius for every badge                                                                |
| Padding     | `px-2 py-0.5`                                 | One inset for every badge                                                                 |
| Line height | `leading-snug`                                | 1.375 of the badge's own font size, never an ancestor's                                   |
| Layout      | `inline-flex items-center gap-1 align-middle` | Icon and label share one row; `align-middle` applies where the badge is a real inline box |
| Icon        | `[&>svg]:size-3`                              | A direct child icon is 12px; call sites pass no size                                      |

The badge owns geometry and nothing else. Typography and foreground stay with
the caller, because a badge reads as secondary beside body text in one place and
as the value itself in another; pass `text-xs font-medium text-muted-foreground`
or let the badge inherit its context. Width constraints and flex behaviour
(`max-w-full`, `break-all`, `min-w-0`, `shrink-0`) also stay with the caller.

Tests scope badges through `data-slot="badge"`, which carries no styles. The
icon rule and that slot follow shadcn's badge, which this package's components
come from; the rest of shadcn's badge does not fit, because it bakes in
`text-xs font-medium` that the diagnostic chips inherit from their row instead,
and `whitespace-nowrap overflow-hidden` that would stop the long key/value chips
from wrapping.

Line height belongs to the badge because a font-size utility with an arbitrary
value carries no paired line height. A badge declaring only `text-[11px]` takes
its box from whatever `line-height` an ancestor happens to set, which varies by
tens of pixels across ancestors. It reuses the page-surface border tokens rather
than declaring badge-specific aliases, so one hairline decision keeps one owner.

Merge the badge's line height **after** caller classes. `tailwind-merge` removes
an earlier line-height utility when a later font-size utility appears: `text-xs`
replaces it with its paired line height, while `text-[10px]` leaves line height
inherited. The badge keeps `leading-snug` last so both named and arbitrary font
sizes retain the same unitless ratio. Callers choose the font size, not a
separate line height.

Control typography is a joint decision about font size, line height, height, and
padding. Keep that decision in the shared component; fixed-height buttons and
segments retain their own size scales. A line-height ratio is not a promise to
center every label's ink: capitals, descenders, and fallback fonts have
different extents. Verify stable baselines, descender clearance, icon alignment,
and long-label wrapping in a browser across representative Latin and Chinese
labels. Do not shift individual labels or impose a font-metric threshold on
every control to make one word look centered.

### Neutral button and select variants

Use `Button variant="neutral"` for neutral actions and
`SelectTrigger variant="neutral"` for neutral select controls. Each component
owns its utilities; their public API does not export class strings. Use
`Button asChild variant="neutral"` around a router `Link` for navigation styled
as a button, and compose `Button` with `DialogTrigger` for dialog actions. The
existing components own the interaction contract; `neutral` is only a visual
variant. Link composition preserves the native anchor, ref, and navigation
behavior without adding a wrapper.

The components compose
`border border-control-border bg-control-surface text-foreground [&:hover]:bg-state-hover-overlay`
internally. Language, timezone, and voice-input settings all use the select
variant. Dimensions, padding, and radius remain with the existing component and
caller.

State both interactions as overlays above the surface
(`[&:hover]:bg-state-hover-overlay [&:active]:bg-state-pressed-overlay`), not as
replacement fills. `hover:bg-state-hover` and `active:bg-state-pressed` set
`background-color`, so they replace `bg-control-surface` rather than sitting on
it: `gray-50` is a warm stop (hue 15°, saturation 40%) and the state layer is
neutral, so a replacing fill drops the warm cast the resting fill carries, while
an overlay stays in the same family.

`text-foreground` is stated explicitly even where every current consumer already
inherits it, so a control moved onto a differently colored surface keeps this
treatment.

Preserve consumer-specific interaction colors when extracting shared styles. The
official workflow Configure button, for example, retains its existing
`hover:bg-primary-hover active:bg-primary-pressed` overrides.

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

`IconTooltip` merges its disabled-child wrapper's utilities with `cn()`, and the
Mermaid diagram box passes its own `wrapperClassName` into that slot.

### Dialog viewport ownership

`DialogContent` owns the Base UI viewport and popup. Windowed dialogs are
centered inside the four safe-area insets plus a 24 px gutter. Fullscreen
dialogs paint to the viewport edges while their content and close control stay
inside the safe-area insets. The environment values come from the existing
`--sat`, `--sar`, `--sab`, `--sal`, and `--okou-viewport-height` properties; the
shared primitive also works with native `env()` insets outside Platform.

Callers select `maxWidth`, `smMaxWidth`, `height`, and `mode`. The popup fills
the available safe width and is capped by `maxWidth` (default `lg`);
`smMaxWidth` changes that upper bound only from the shared `sm` breakpoint.
Width caps never set a fixed width or determine height. Preserve existing
breakpoints and units when migrating: `sm:max-w-[480px]` becomes
`smMaxWidth={480}`, and `max-w-[25rem]` becomes `maxWidth="25rem"`. The artifact
preview uses `maxWidth={1440} height={1000}`. Every variant is capped by the
available viewport, so increasing a cap cannot increase the safe boundary.

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

### Chat transcript cards

`ChatCard` in `turbo/apps/platform/src/views/okou-page/components/chat-card.tsx`
owns the surface shared by transcript notice cards, action cards and media
frames. It follows `Badge`'s `useRender` shape, so a caller picks the host
element with `render` and gets no wrapper. It is App-owned rather than shared,
because its radius and shadow read the App-only `--okou-chat-card-*` variables,
which the App stylesheet declares at `:root`.

The border is deliberately `border-[1px] border-gray-400` rather than the shared
`border` hairline and a semantic border token. A fractional border visibly
repaints when card contents resolve, so a card would flicker at its edge as an
image or an iframe lands; a whole pixel does not. Unifying the transcript's
border width and color with the rest of the product is a separate visual
decision.

`cn()` merges the base with the caller's `className`, so a conflicting base
utility is dropped rather than outranked and no layer ordering is involved. The
browser session card's hover and selected borders rely on this.

The radius and shadow use `rounded-[var(…)]` and `shadow-[var(…)]`, matching the
call sites that read the page-level `--okou-card-*` siblings the same way.
Tailwind's shadow utility composes `--tw-shadow`, so the serialized `box-shadow`
carries four fully transparent placeholders; the painted result is unaffected,
and a comparison should normalize them away rather than treat the string as the
contract. One consequence is that `tailwind-merge` cannot classify an arbitrary
`shadow-[var(…)]` as a box-shadow and so will not drop it for a caller's own
`shadow-*`. No consumer overrides the shadow today. Registering `@theme` tokens
and a named `shadow-*` scale in `cn()` would restore that, and is the documented
route if a consumer ever needs it.

Giving the artifact preview a card surface is a separate visual decision: its
container currently has no card treatment, and adopting the shared base there
would change its appearance substantially.

## Cross-cutting rules

These apply wherever the situation comes up, not only to the surface that first
met it.

### Horizontal hairline rules

A rule between rows of a settings card, list or menu is
`border-t border-t-gray-400`. The width joins the shared hairline — `border-t`
reads `--default-border-width` rather than naming a value — so these rules are
not a second registry for a decision that token already owns.

These are rules rather than real borders, so the `bg-divider` guidance above
would suit them. Adopting it would change their color, which is a visual
decision and belongs to a separately reviewed change.

The shared `Select` and `DropdownMenu` separators compose these utilities
alongside their existing `border-0`. That paints because Tailwind emits
`border-width` before `border-top-width` inside the utilities layer. Tests
select both separators through `data-slot`.

### The all-round hairline

A four-sided hairline on a settings card, diagnostic panel, table or chip is
`border border-surface-border`. `--color-surface-border` is the registered name
for this decision — the page-surface and badge tables above point at it — so
these consumers take it rather than the raw `border-gray-400` ramp stop the
horizontal rules kept. `border-border` would be wrong here: `--border` is
`--gray-300`, one stop lighter.

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
cycle and visibly misplace the indicator at every phase.

Register a keyframe animation as an `--animate-*` theme entry so consumers reach
it through `animate-*` rather than an `animation` shorthand. A per-instance
runtime value, such as the indicator's phase-anchoring
`--running-indicator-delay`, stays a narrowly named custom property that the
component sets, read through an arbitrary `[animation-delay:var(...)]`.

A `@media (prefers-reduced-motion: reduce)` override that resets a value back to
its initial belongs on `motion-safe:` on the rule it would override, rather than
as a second `motion-reduce:` utility. Both utilities land in the same layer at
the same specificity, so a `motion-reduce:` override would depend on Tailwind's
emission order to win; `motion-safe:` simply does not apply, and the registered
initial value is what reduced motion resolves to anyway.

### Literal colors and gradients

Tailwind's color and gradient utilities interpolate in oklab, so they do not
reproduce a literal `rgb()` fill or a plain `linear-gradient()`. Reach for the
ergonomic utilities when a token supplies the color, and for an exact arbitrary
value such as `bg-[rgb(255_255_255_/_0.18)]` or
`bg-[linear-gradient(to_top,#bdf9ff,#ffffff)]` when a specific value is part of
the design.

The mic starting spinner sets `[transform:rotate(0deg)_translateZ(0)]` for the
same reason the running indicator does: its keyframes animate `transform`, and
Tailwind's `rotate-*` utility sets the individual `rotate` property, which would
compose with the animation rather than be replaced by it.

### Ancestor state without the hover media query

Tailwind wraps `hover:` and `group-hover:` in `@media (hover: hover)`, so a
`group-hover:` utility is not equivalent to an ungated `.parent:hover .child`
rule: the ungated form also fires on coarse pointers, where a tap leaves a
sticky hover. Reproduce that contract with an arbitrary variant over the
element's own semantic attribute, as in
`[:is([data-sidebar-chat-thread-id]:hover,[data-sidebar-chat-thread-id]:focus-visible)_&]:…`,
which generates the same unconditional descendant selector at the same
specificity, and folds a two-state rule into one utility. This matches the
unconditional `[&:hover]` form the choice and surface variants use; reach for
`group-hover:` only when the media gate is wanted. The sidebar copy foreground
is such a case: it keeps the guard deliberately, because a foreground that never
repaints on a sticky tap state is the better behaviour there, while a title that
never scrolls to its end would lose the affordance.

Spell such a variant out at every call site. Tailwind's scanner is text-based,
so a variant assembled from a constant produces a candidate that never appears
in the source and therefore generates no CSS at all.

The sidebar thread title keeps its `@property --okou-nav-title-shift`
registration in the App stylesheet. A registration is an at-rule rather than a
class selector, and it is what lets a transition interpolate the length and
`inherits: true` carry the animated value to the text span; the mask, the travel
and the delayed hover transition are Tailwind utilities on the component.
`data-slot="sidebar-thread-title"` identifies the clipping box for page tests
and carries no styles.

### Illustration strokes

`--border-width-illustration` (1px) and `--border-width-illustration-marker`
(1.5px) are App-layer tokens for artwork that is drawn rather than chrome. They
are a different decision from `--default-border-width`, not a competing value
for it, in the same way `border-2` is: the hairline decides how thick _a border_
is, while an illustration owns the weight of its own outlines. Both are
identical in Light and Dark, because a stroke weight is not a theme value.
Consumers read them through `border-(length:--border-width-illustration*)`
beside `border-solid`, the same shape `Card` uses for `--border-width-surface`.

Their scope is artwork, and nothing else. A control, surface, card, input,
divider or any other piece of product chrome takes the shared hairline; reach
for these only for a drawing whose strokes are part of the picture. They live in
the App token layer because the onboarding diagram is their only consumer today,
and they promote to `@okouai/ui` when a second product surface draws with them.
Adding a third weight is a token change, not a call-site decision.

The first consumers are the onboarding diagram's tiles: the icon box, the
connector stack items, the overflow badge and the two action cards take
`--border-width-illustration`, and the six waypoint dots take the marker weight.
Those tiles otherwise use the semantic `bg-card` fill and `border-border`
stroke, `rounded-surface` for the action cards and the artwork's own
`shadow-[0_12px_30px_-18px_rgba(0,0,0,0.5)]` lift.

`white` is not white here. `--color-white` is `hsl(var(--white))`, a
theme-flipped token that resolves to a near-black in Dark, so a drawing that
wants real white spells the literal `#ffffff`. Check any white in artwork
against Dark before reaching for `border-white`.

## Surface notes

Decisions that belong to one surface. Read the relevant note before changing
that surface; none of them generalizes on its own.

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
their native root element. A page does not restate the shell it renders inside.

Viewport sizing stays on the existing native roots through
`box-border h-full max-h-full min-h-full overflow-hidden`. Page roots reserve
the bottom safe-area inset with `pb-(--sab)`; `SidebarLayout` uses `pb-0` so its
scrollports reach the viewport edge and its content/composer owns the inset.
Document sizing, top and horizontal insets, and PWA keyboard handling remain
owned by the existing global environment rules.

A page that covers the viewport is the exception. The browser session page is
`fixed inset-0`, so it is positioned against the viewport rather than inside
`#root` and inherits none of the insets that element applies; `#root` reserves
the top and horizontal insets for every route, but a fixed descendant is laid
out past them. That page therefore takes all four insets with `p-safe` and pins
its own height with `h-viewport max-h-viewport min-h-viewport`.

Both are registered names rather than respelled variables, for the reason the
`--animate-*` entries give: a consumer should reach a decision through its
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

`position: fixed` changes where a box is laid out, not where it sits in the DOM,
so a shell's custom properties still inherit into a fixed cover.

### Sidebar copy and nav chrome under the gradient color themes

A treatment that applies only under the gradient palettes collapses to the
variable layer rather than to a conditional selector. The raw values are defined
at `:root` under the palette attributes, and each consumer reads a registered
token that falls back to what it already had:

```css
:root[data-gradient-color-themes][data-color-theme] {
  --nav-copy: hsl(var(--okou-color-theme-hue) 24% 18%);
  --nav-copy-muted: hsl(var(--okou-color-theme-hue) 18% 38%);
  --nav-rail: hsl(var(--okou-color-theme-hue) 36% 93.5%);
  --nav-border: hsl(var(--border) / 0.5);
}
```

A dark counterpart under
`:root:is(.dark,[data-theme="dark"])[data-gradient-color-themes][data-color-theme]`
carries the same four names at their dark values. Consumers read the registered
token rather than either raw block:

```css
--color-nav-copy: var(--nav-copy, var(--color-sidebar-foreground));
--color-nav-copy-muted: var(--nav-copy-muted, var(--color-muted-foreground));
--color-nav-border: var(--nav-border, var(--color-sidebar-border));
--color-nav-rail: var(--nav-rail, var(--color-sidebar-rail));
```

When the gradient themes are on, the raw values exist and every consumer
resolves to them. Everywhere else they are unset and each consumer falls back to
the foreground or surface it already had, so both sides keep their appearance
without a conditional selector. Consumers whose value matches a registered
fallback use `text-nav-copy`, `text-nav-copy-muted`, `border-nav-border` or
`bg-nav-rail`; the rest carry their own fallback in the utility, including
`var(--nav-copy, inherit)` where the consumer inherits its color from an
ancestor `Link` or `button` and must keep inheriting that ancestor's hover.

This narrows the contract on purpose. A scoped rule overriding an _inherited_
token on a whole subtree means any descendant spelling `border-sidebar-border`
silently takes the gradient alpha; a named utility is opted into. A future nav
descendant that wants the gradient stroke asks for `border-nav-border` by name.

The expanded drawer carries `data-slot="sidebar-expanded"` so the account-menu
test selects it through a documented slot.

`group-hover` carries Tailwind's `@media (hover: hover)` guard, so the gradient
themes do not paint the hover foreground onto a sticky tap state. Removing that
guard would need either a first-party selector or a global `hover` variant
override, and the guard is the better behaviour.

### Card geometry at the document root

`--okou-card-radius`, `--okou-chat-card-radius`, `--okou-card-shadow` and
`--okou-chat-card-shadow` are owned at `:root`, for the reason
`--okou-composer-focus-veil` records: a portaled surface is not a descendant of
the app shell, so a scoped declaration never reaches it, and a card rendered
through `SheetPortal` or `DialogContent` would resolve the radius to nothing and
fall back to square corners. The palette override follows them, keyed on the
`data-gradient-color-themes` attribute `signals/theme.ts` writes onto the
document element.

### The workspace canvas

The workspace pane's `::before` paint layer reaches its fill and gradient
through `bg-workspace-canvas` and `bg-workspace-canvas-image`, registered as
`@theme inline` entries over `--okou-workspace-canvas-fill` and
`--okou-workspace-canvas-image`. `inline` keeps the reference, so the theme and
palette attributes decide at use time.

The four variants — default and gradient palette, each in Light and Dark —
differ only in a fill color and a gradient, so they are two runtime values
keyed at `:root` rather than four selectors. `signals/theme.ts` writes
`data-theme` and `data-gradient-color-themes` onto the document element; each
theme test wraps in `:where()` so it stays at the specificity of the rule it
refines and source order decides between them. Do not add the paired `.dark`
class: a class in the selector registers a first-party class-selector
declaration against the shrink-only baseline, and the document-level selectors
that spell it are allowlisted rather than exemplary.

Consumers spell `before:bg-[length:100%_100%]` beside the two background
utilities. `background-size: 100% 100%` and the initial `auto auto` size a
gradient to the same box, so it is a stated rather than a load-bearing value.

### Chat message bubbles

A Markdown frame inside a bubble asks for the bubble's block treatment by name:
pass `chatBubble` to `MarkdownEventBody`. Do not respell the treatment at a call
site, and do not drop an `!` from the class string below — every one of them is
load-bearing, for the cascade reasons this section records. The bubbles
themselves are ordinary utilities.

The user bubble writes `bg-gray-200 text-foreground`; the assistant bubble
writes `bg-transparent border-none border-current`. The color utility is there
because `border: none` is a shorthand that also resets `border-color` to
`currentcolor`, while `border-none` sets only the style. The width is 0 either
way, so this is invisible today; it is stated so an assistant body that later
carries a border keeps the treatment it has now.

The Markdown block treatment applies to elements the Markdown library renders.
`MarkdownEventBody` takes a `chatBubble` prop and composes the whole treatment
onto the frame it already owns:

```
[&_:is(p,[data-slot=markdown-card])]:my-2! [&>*:first-child]:mt-0!
[&>*:last-child]:mb-0! [&_blockquote]:py-2!
[&_blockquote>*:first-child]:mt-0! [&_blockquote>*:last-child]:mb-0!
[&_hr]:hidden
```

Every margin there is important, and the four resets exist only because of it.
The competitor for the paragraphs is the App's own unlayered `.wmde-markdown p`
rule, which a utility in `@layer utilities` cannot outrank without one; a
layered important declaration does. The card slot carries a `my-1.5` utility of
its own, which the important declaration outranks from inside the same layer, so
both halves land on the bubble's 8px. The vendored
`.wmde-markdown > *:first-child` / `> *:last-child` resets carry `!important`
and therefore beat every unlayered rule whatever the source order is, so
restating them at the same tier is what keeps the frame's own edge paragraphs
flush.

The vendored `blockquote > :first-child` / `:last-child` pair is a different
case, and source order decides it: the Markdown chunk's stylesheet reaches the
bundle through a static `router.tsx` import chain that `main.tsx` evaluates
before its own `./css/index.css`, so Rollup emits the vendored rules first and
the App block wins every tie.

A blockquote here declares `padding: 0 1em` and a left border only, so a first
or last child's block margin has no block padding or border to stop it and
collapses straight out through the quote's own edges — as leaked space at the
bubble's top and bottom rather than as spacing inside the quote.
`[&_blockquote]:py-2!` gives the quote the bubble's 8px as block padding, where
it is both visible and contained, and `[&_blockquote>*:first-child]:mt-0!` with
its `mb-0!` sibling keeps the inner margins from adding a second, escaping copy.
Resolves [#34278](https://github.com/vm0-ai/vm0/issues/34278).

The padding needs its important for a sharper reason than the margins do:
`.wmde-markdown blockquote` declares `padding: 0 1em` unlayered, and an
unlayered normal declaration outranks a layered one whatever its specificity, so
a non-important `[&_blockquote]:py-2` compiles and matches but changes nothing.
`[&_hr]:hidden` needs no important, because nothing unlayered declares `display`
on a Markdown rule.

The card slot is addressed through `data-slot="markdown-card"`, which carries no
styles, and `data-slot="chat-user-message"` identifies the user bubble for the
attachment-preview test.

Asking by name narrows the contract on purpose, the way the nav chrome above
does. The treatment reaches the three call sites that request it — the chat
transcript's Agent message, and the shared thread's rendered and rich-content
Agent messages — rather than any Markdown frame that happens to sit inside a
bubble.

### Chat thinking states

The thinking and skeleton motions are registered `--animate-*` entries, so
consumers reach them through `animate-thinking-in` and
`animate-chat-skeleton-reveal`. The spinner keeps `animate-spin` and overrides
only its duration, through `[animation-duration:1.4s]` beside
`will-change-transform`. Keyframes stay in the stylesheet, because keyframes are
not class selectors.

`ShimmerText` in `chat-thread-page.tsx` owns the shimmer treatment.
`--background-image-shimmer-text` is an `@theme inline` entry, so
`bg-shimmer-text` emits the gradient with its `--muted-foreground` and
`--foreground` references intact and each theme resolves them on the element;
Tailwind's own gradient utilities interpolate in oklab and compose from three
positions, so no `bg-*` utility can express its six color stops.
`--animate-shimmer` joins the `--animate-*` entries beside it on the same
contract.

Two of its utilities need stating. `[background-size:200%_100%]` is an arbitrary
property rather than `bg-size-*`, matching the effort slider's
`[background-size:…]` beside its own aurora tokens. And
`[-webkit-background-clip:text]` stays beside `bg-clip-text` because Tailwind
emits only the unprefixed property; Chromium treats the two as aliases, so
removing the prefixed declaration is a browser-support decision rather than a
styling one.

### Table header rules and the global scrollbar treatment

The App stylesheet applies the scrollbar treatment — `scrollbar-width`,
`scrollbar-color`, and the four `::-webkit-scrollbar*` rules — to `*`, and
`@okouai/ui` is consumed only by the App, which imports that stylesheet. Do not
restate those declarations on a surface. Reach for the scrollbar utilities only
where a surface wants something other than the global treatment, as `DialogBody`
does.

`TableHeader` writes `border-b border-b-border [&_tr]:border-b-0` for the header
separator and its suppression on the header row. Tailwind's Preflight sets
`border-collapse: collapse` on tables, and a collapsed border resolves to a
whole CSS pixel, so the shared hairline and a literal `1px` compute the same
`border-bottom-width` here; the hairline's half-ink behaviour applies to
separate borders, not to a collapsed table edge.

`[&_tr]:border-b-0` is currently redundant for the same collapsing reason — the
header row's own `border-b` loses to the row-group border at the same boundary —
and is kept so a header row that later carries a wider border keeps today's
appearance. Leaving the separator to `TableRow` instead is not equivalent: a row
border never wins that boundary, so the header rule disappears and every body
row shifts up.

### The Markdown code-fence copy control

`CodeBlockCopyButton` owns the copy affordance for both fence shapes: the one
the Markdown pipeline marks on every fenced block, and the one the Mermaid view
renders when a diagram's source does not parse. The App mounts no part of
`@uiw/react-markdown-preview` — it imports only the stylesheet, and parses and
renders Markdown itself — so the element is first-party markup and the control
owns its own treatment rather than borrowing the vendored sheet's.

Four spellings in that control need stating.

`text-[12px]` names the size rather than taking `text-xs`, for the reason the
badge section records: an arbitrary font-size utility emits `font-size` alone,
while `text-xs` would add a paired line height this control does not want.
`ease-[ease]` is needed for a similar reason — a Tailwind transition utility
supplies Tailwind's own `--default-transition-timing-function`, not the CSS
`ease` initial value.

The transition names its properties rather than taking `all`, as the rule above
requires for an auxiliary control revealed by hover. Only `visibility`,
`background-color` and `color` change on this control, and `visibility` has to
stay in the list: with it the control remains painted for the transition's
duration after the pointer leaves, and without it the control vanishes
instantly.

The reveal and both interaction fills spell `pre:hover &` rather than reaching
for `group-hover:`, so they also fire on a coarse pointer where a tap leaves a
sticky hover. Spelling the ancestor also raises specificity above the shared
control's own `hover:` fill, so the two stop racing inside one Tailwind layer.

The hovered fill carries `:not(:active)` because Tailwind sorts the pressed
variant first, so the hovered fill steps aside by selector rather than by source
position.

### The Mermaid fallback fence

`MermaidDiagramView` renders an ordinary code block when the parser rejects a
fence's source, and that block carries no class. No first-party declaration
matches `language-mermaid`, and the pipeline runs `rehype-prism-plus` with
`ignoreMissing: true` over a grammar bundle that carries no mermaid grammar, so
a mermaid fence is never tokenised on either path.

`lib/rehype-mermaid.ts` does spell the class, and that use is in a different
category. It reads the class off a tree it did not author, to recognise a
Mermaid fence before a diagram marker replaces it: `marked` writes the class for
a Markdown fence, and a message carrying raw
`<pre><code class="language-mermaid">` HTML writes it directly. Both are
external DOM contracts being parsed, not first-party styling, so neither the
legacy baseline nor `no-unknown-classes` counts them — the baseline resolves
class attributes and class-helper calls, and the rule reads class attributes
only. Page tests that query `code.language-mermaid` likewise match
pipeline-generated markup, not this component.

### Markdown card block spacing

A Markdown card slot spells its block rhythm as `my-1.5`, which emits
`calc(var(--spacing) * 1.5)` over the default `0.25rem`. It emits `margin-block`
where a `margin-top`/`margin-bottom` pair would set two physical edges; the App
has no vertical writing mode, so the two resolve the same way.

`.wmde-markdown > :first-child` and `> :last-child` are unlayered, so they zero
the outer margin of a first or last card and the utility applies everywhere
else. The `.wmde-markdown p` selector is a `third-party-dom-adapter` entry, one
of the seven `.wmde-markdown` rules that declare a margin.

### Toast styling under an unlayered stylesheet

Sonner injects its stylesheet into `document.head` at module load, unlayered.
Unlayered rules outrank every layer, so a `@layer utilities` declaration loses
to `[data-sonner-toast][data-styled="true"]` no matter how specific the variant
is. That is why the toast class string carries `!` on most of its utilities, and
it is why the four that lack it — `bg-popover`, `text-foreground`,
`border-border` and `shadow-lg` — have never applied: a dark toast computes
white on `rgb(23, 23, 23)` while `--color-popover` is `hsl(20 2.9% 20.2%)`, so
the panel stays light in Dark. The component also passes no `theme` prop, so
Sonner itself is permanently in its `light` palette. The `description`,
`actionButton` and `cancelButton` entries are inert for the same reason.

Restoring those declarations is a visual decision, not an equivalence repair,
and it is tracked separately. Marking the four important does fix Dark, but it
also moves the Light foreground, border and shadow, and — because `!important`
beats Sonner's unlayered `:focus-visible` rule — it replaces the toast's focus
ring with the resting shadow. Adopting Sonner's supported `theme` prop instead
takes Sonner's palette rather than the App's popover tokens. Draining `toaster`
is blocked behind that choice, because whichever repair wins rewrites the same
class string.

### The standalone PWA fixed cover

A `fixed inset-0` cover is clipped by the visual viewport, so in a standalone
PWA it stops short of the bottom safe inset. The mobile drawer scrim and the
artifact-preview dialog backdrop each write
`[@media(display-mode:standalone)]:bottom-[calc(-1*var(--sab))]` to paint to the
physical edge while their content keeps its safe-area padding.

Tailwind has no `display-mode` variant, and this is a genuine environment
condition rather than a token decision, so it stays an arbitrary variant over an
arbitrary value — the shape the existing `[@media(hover:hover)]:` call sites
use. The utility has to win against the `inset-0` on the same element, and it
does: Tailwind emits the `inset` shorthand before the `bottom` longhand inside
`@layer utilities`, and `cn()` keeps both, because a modifier-prefixed
`bottom-*` never conflicts with an unprefixed `inset-0`.

The mobile drawer `aside` carries the same utility, plus `max-md:p-safe` for its
four-value padding. Its `::before` layer exists for one case: the `aside`
already carries `bg-sidebar`, so that fill is invisible wherever the element's
own box is, and the layer's only visible work is the standalone extension below,
which paints the sidebar color into the home-indicator area. `isolate` keeps
the `-z-1` layer inside this element instead of letting it fall behind the page.

`max-md` is not an exact restatement of `max-width: 767px`. Tailwind emits
`@media (width < 48rem)`, so a fractional viewport width strictly between 767px
and 768px takes the padding where a `767px` bound would not. Every integer width
agrees, and the element already gates its whole fixed-drawer geometry on
`max-md`.

### The onboarding workflow diagram canvas

The diagram is a fixed 614x470 illustration scaled to 0.6. Its geometry, motion,
typography and coordinates are Tailwind utilities on the component.

The beam registers `--animate-owf-beam-flow` as an `--animate-*` theme entry,
the same form the thinking states use, and its keyframes stay in the stylesheet.
Its reduced-motion behaviour — cancel the animation and dim the beam from 0.92
to 0.35 — belongs to `motion-safe:`: the element carries `opacity-[0.35]` with
`motion-safe:opacity-[0.92] motion-safe:animate-owf-beam-flow`. A
`motion-reduce:` utility would have depended on emission order to win.

The beam gradient, both of its drop shadows and the two literal brand strokes
keep their exact values in arbitrary utilities, because Tailwind's gradient
utilities interpolate in oklab and this gradient has five stops with literal
`rgba()` colors. The grid's radial gradient likewise spells
`hsl(var(--gray-500)/0.55)` rather than a ramp utility, because that alpha is
part of the artwork.

Type maps onto the shared scale exactly: the node labels' 12px/16px is
`text-xs`, the action title's 16px/24px is `text-base`, and its description's
14px/20px is `text-sm`, so no arbitrary font size survives. The description
keeps `text-ellipsis` beside `line-clamp-2`, which the utility does not imply.

Page tests select the source node and source dot through
`data-slot="onboarding-diagram-source-node"` and
`data-slot="onboarding-diagram-source-dot"`, which carry no styles.

## Exception boundary

Only two exception kinds exist:

- `global-environment` covers document-level browser or theme state that cannot
  be represented by a component utility.
- `third-party-dom-adapter` covers DOM or isolated documents whose element
  classes are owned outside the business component.

Hosted Clerk authentication does not use a third-party DOM adapter. It stays on
Clerk's public appearance API under the narrower rules in
[Clerk customization](./clerk-customize.md).

Every exception identifies the exact file and selector or injected-style
fingerprint, its owner, rationale, and removal condition. Third-party adapters
also identify their upstream DOM owner. A styling convenience, missing utility,
or existing first-party convention is not an exception. Vendored CSS is pinned
by exact path and SHA-256 rather than by a directory-wide ignore.

### Third-party attribution of borrowed class names

A class that looks like a vendor's is not automatically that vendor's. The
exception boundary follows who authors the element, not who the name resembles.
A first-party element borrowing a vendor fingerprint to reach a first-party rule
is legacy debt, not an adapter, and takes a utility instead.

An icon stroke is `stroke-icon`. Tailwind resolves `stroke-*` against
`--stroke-width-*` before it falls back to a bare number, so the token lives at
`--stroke-width-icon` and emits `stroke-width: var(--stroke-width-icon)` as a
plain named utility — the same shape the emoji spans use with
`font-family-emoji`: a registered token read through its own namespace, not a
custom property threaded through an arbitrary or data-type-hinted utility. Bare
`stroke-2` keeps working, because the namespace lookup only precedes the numeric
fallback. The two `lucide` rules remain for the real `lucide-react` DOM,
including the allowlisted `svg.lucide-ellipsis circle` entry.

`toaster` in `components/ui/sonner.tsx` is the mirror case. It is one of the two
legacy class dependencies left in Platform and UI, beside `wmde-markdown` in
`markdown-frame.tsx`. Sonner neither defines nor requires that class; the
component invents it, hands it to Sonner's `className` prop, and then anchors
its own `group-[.toaster]:` variants on it. Sonner's actual contract is the
`[data-sonner-toaster]` attribute it puts on its own list element. There is also
no mechanism to authorize this kind of dependency: `turbo/style-allowlist.json`
holds CSS selectors, style injections and vendored files, so a legacy class
named in a component's `className` can only be drained or left in the
shrink-only baseline — never allowlisted.

## Shrink-only legacy state

`turbo/style-legacy-baseline.json` records current first-party selector
declarations as normalized CSS AST atoms, including nested selector ancestry,
conditional at-rules, `@scope` roots and limits, and `@apply` contents. A
class-qualified scope also freezes its `:scope`, `&`, and element-selector
declarations; scope boundaries participate in exact baseline and adapter
matching. Legacy class dependencies are counted at their consuming attributes or
calls, resolving local constants, imported aliases, and re-exports. Reusing an
existing constant in another consumer is a new dependency. The baseline also
fingerprints existing inline or injected styles that are not permanent adapters.

The baseline is not an allowlist and has no command that expands it. A new
selector, a changed declaration, a new use of an existing legacy class, or a new
style injection fails lint. Removing legacy state intentionally makes the
baseline stale; `pnpm lint:style:prune` only intersects the baseline with
current source and refuses to authorize growth. Pre-commit compares the baseline
with `HEAD`, while CI compares it with the pull request or merge-queue base SHA,
so manually editing source and baseline together cannot bypass the ratchet.

Commands run from `turbo`. An invalid Git reference, unreadable baseline, or
malformed JSON fails with a nonzero exit status and a pointer to this guide.
Only a reference commit genuinely predating the baseline file permits its
initial introduction. That bootstrap case applies to local/CI repository
history, not production version compatibility; once the target base contains the
baseline, the ratchet is mandatory.

## Enforcement and feedback

Run the complete check from `turbo`:

```bash
pnpm lint:style
```

The check has three layers:

1. The repository policy compares CSS AST atoms, legacy class dependency counts,
   injected-style fingerprints, exact adapter entries, and vendored file hashes.
2. `@eslint/css` parses first-party CSS with Tailwind v4 syntax and disallows
   inline ESLint configuration for this check.
3. `eslint-plugin-better-tailwindcss/no-unknown-classes` validates component
   class strings against the real App Tailwind entry point while accepting only
   the recorded legacy tokens.

CI runs this as the independent required `lint-style` job. The pre-commit hook
runs the fast repository policy so the most actionable boundary failures are
returned before push. Both policy diagnostics and the full lint command's
failure output direct contributors to `docs/styles.md` for the style guide. The
full command keeps a failing exit status for policy, CSS, Tailwind, or test
failures.

When a style check fails, read this guide and replace business styling with the
appropriate Tailwind utilities and registered tokens. Prune the baseline when
legacy code has been removed. Do not suppress the check or add a business
styling exception to make it pass.

## App palette previews

`bg-palette-anchor bg-palette-gradient` renders the color-theme anchor and its
fixed companion gradient. These App-owned domain utilities use `@theme inline`
so each element resolves its own `data-color-theme` anchor/companion instead of
inheriting the selected document palette. The 135-degree gradient and 52% sRGB
midpoint are identical in Light/Dark; consumer geometry stays at the call site.
