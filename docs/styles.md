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
| Building a dropdown, menu or select row                   | [Menu and select rows](#menu-and-select-rows)                                                                                                                                   |
| Building a button or a select                             | [Neutral button and select variants](#neutral-button-and-select-variants)                                                                                                       |
| Building a dialog, sheet or scrolling body                | [Icon controls and dialog bodies](#icon-controls-and-dialog-bodies), [Dialog viewport ownership](#dialog-viewport-ownership)                                                    |
| Building a card inside the chat transcript                | [Chat transcript cards](#chat-transcript-cards)                                                                                                                                 |
| Adding an overlay, fullscreen panel or action bar         | [Floating layers and portal ownership](#floating-layers-and-portal-ownership)                                                                                                   |
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
  be authorized by disabling lint or adding an allowlist entry.

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

The product draws lines at two weights, and a component picks between them by
what the line is doing, not by which state it is in.

One hairline serves the whole product. `--default-border-width` in the shared
`@theme` is 0.5px, and Tailwind's bare `border`, `border-t`, `border-x`,
`divide-y`, and their siblings all read it, so a component asks for "a border"
and the system decides how thick it is. Components must not hand-write a width:
an arbitrary bracketed width, or a literal width inside a `style` prop, is a
second registry for a decision this token already owns, and the two round to
different device-pixel counts wherever the device scale is odd.
`no-restricted-syntax` in `eslint.style.config.mjs` rejects both, and the two
files that legitimately spell a width turn the rule off by name with their own
reason: both pin a whole pixel, the chat card against the repaint a fractional
border shows when its content resolves.

This is a real hairline, not a rounding no-op. On a 2x display 0.5px paints one
device pixel where 1px paints two, so every bare border carries half the ink it
used to; layout is unaffected, because the used value is still rounded to whole
pixels. Colour has to carry what the width no longer does, which is why
`--border` sits one stop darker than the surface ramp's lightest step:
`gray-200` was calibrated for a 1px line and stops reading on a near-white card
at half the thickness.

`--border-width-emphasis` is 1.5px, and it is for one thing: a line drawn
against artwork, where the hairline would read as part of the picture instead of
as chrome. A boundary around something that already reads takes the hairline.
Today that rule covers three kinds of line. The first is selection on a tile
whose content is a picture — a chart silhouette, an avatar look, a template
preview — where selection cannot be carried by a fill, because the artwork owns
the interior, nor by the label, because it sits outside the box. The edge is all
that is left, and a hairline cannot do it: one device pixel appearing at the rim
of a filled tile reads as an antialiasing artifact, not as a state. The second is
a mark laid over artwork that needs a ring to stay legible against whatever is
behind it, such as an annotation pin or a count badge on a preview. The third is
a ring that marks artwork as the product's own and actionable, such as the
account avatar's editable ring in `settings-tab.tsx`, which carries no selected
state because it is never not emphasized. Consumers read it through
`border-(length:--border-width-emphasis)`, the same way the surface and
illustration widths are read.

1.5px is not a new value. It is what `--stroke-width-icon` already draws at, so
an emphasized edge and an icon stroke are one weight expressed in two units —
the icon token is unitless because it resolves in SVG user space.

In the tile case this is a width for the whole surface, not for its selected
state. **A selection must never change an element's metrics**, so the resting
branch carries the same width in `border-transparent` and only the colour is
stateful; a token named for the state would invite `selected &&
"border-[1.5px]"`, which reflows the tile and shifts its siblings. This is the
same rule that keeps a selected chip's font weight on its base class, and the
generalization of "Keep the border width constant across interaction states"
below from focus to selection.

Everything that is text plus a fill — pills, chips, menu rows, table rows, plan
cards — keeps the shared hairline in both states and recolours it to
`border-primary`. Selection is never a ring: `ring-*` belongs to the focus
indicator, which the large majority of its usages already spell as
`focus-visible:ring-2`, and a selected row that also draws a ring gives a
keyboard user two rings fighting on one element. Selection owns the border,
focus owns the ring. A ring on an element that has no selected state is not a
selection ring and is unaffected — the account avatar's halo stays, because
nothing about it changes when the user picks something.

`border-0` stays available, and so does a literal `border-2` for geometry that is
not a boundary at all — a dashed drop target, a spinner's ring, the inset that
shapes a switch track. Those express a different decision rather than a competing
value for the same one. Selection is not on that list.

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

The picker's first option, `default`, is the product's own palette rather than
another preset. `signals/theme.ts` writes no palette attribute while it is
selected, so every token keeps the shared Amber-on-Linen values and none of the
`[data-gradient-color-themes]` rules key in — the interface is byte-identical to
the one the capability's switch turns off. Its `[data-color-theme="default"]`
rule therefore declares only an anchor and a companion, for the one element that
does carry the attribute: the picker's own swatch. Neither is a designed colour:
both are `primary-300`, the brand stop the interface already paints with, so the
swatch shows the state it selects rather than a palette invented to represent
it. Repeating the stop is also what removes the gradient — the shared preview
gradient interpolates between two identical colours and resolves to one flat
brand fill, which is correct, because the default state has no second colour and
no gradient to show. For the same reason `--okou-color-theme-selected`, the wash
behind the selected option, is owned at `:root` and refined by the preset rules
rather than existing only under them: one option's selected card must not read
heavier than another's.

When `GradientColorThemes` is enabled on the document, each preset's HSL primary
value supplies both its anchor color and the shared `--primary` token. Primary
actions, including portaled dialog buttons, immediately use that fill and the
preset's contrast-checked `--primary-foreground` in Light/Dark. Hover and
pressed fills blend the anchor toward its companion using the existing
filled-state alpha tokens. Disabled buttons retain the shared opacity treatment.
Removing the document's color-theme attributes restores the shared Amber primary
tokens.

The preset also supplies `--primary-400`, because one filled control reads that ramp stop rather than `--primary`. The checked `Switch` track takes 400 so it sits one step darker than the brand stop, which is what keeps a 44x24 fill reading as a fill on a near-white card; `Checkbox` and `Radio` are small enough to take `--primary` directly. A preset has a single anchor and no ramp, so pointing the stop at that anchor puts the checked toggle on the same fill as every other filled control instead of leaving it Amber under every palette. This is the same move the presets already make on the gray ramp, and it is confined to the one stop with a consumer: `--brand-subtle`, `--brand-text`, and `--brand-text-hover` keep reading the Amber ramp, because the brand mark is not palette-driven.

The label of a selected or pressed control is the one piece of brand-coloured
text that is palette-driven, so it has its own token, `--selected-foreground`.
It defaults to `--brand-text` in both themes, which leaves the product's own
palette byte-identical, and a preset repoints it at that preset's hue. The
reason it cannot stay on the brand stop is the surface it sits on: that label is
painted on the `primary/10` wash inside a `primary/40` border, both of which the
preset already repaints, so an Amber label on a blue wash read as a second
colour system rather than as the selected state. A preset has a single anchor
and no ramp, so the stop is built the way `--nav-copy` is — the preset's hue at
a fixed saturation, and a lightness chosen to clear 4.5:1 on that wash in Light
and on the dark card in Dark. Reach for `text-selected-foreground` for the label
of a control that carries `aria-pressed` or a selected state on the primary
wash; keep `text-brand-text` for accent text that is the brand speaking, such as
link and ghost button labels.

Auxiliary controls and previews revealed by hover or keyboard focus change
opacity immediately. Do not add opacity transitions to message actions, sidebar
controls, card overlays, or similar contextual affordances; temporary
compositing layers can cause nearby content to flicker in Safari. Preserve their
layout, focus visibility, touch behavior, and pointer-event rules. When other
properties still animate, name those properties instead of using
`transition-all`. This does not remove loading or popup lifecycle animations.
The shared scrollbars follow Base UI's official fade behavior, documented under
[Chat scrollbars](#chat-scrollbars).

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
selector is a first-party class-selector declaration, and the policy fails any
that the allowlist does not name. The two document-level theme selectors that do
spell it
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
restating its treatment. Call sites own layout and container-query context;
app-wide stacking belongs to the shell, and floating-layer stacking belongs to
the shared primitives. Follow [stacking ownership](#stacking-ownership) for
any local overlap rather than adding a z-index to a control.

### The composer card surface

`Card` from `@okouai/ui` takes `surface="composer"` for the composer card and
the two surfaces that sit in its place: the service-status notice and the shared
thread's claim prompt. The variant carries the fill, radius, border, shadow, the
focus border transition and the `after` veil layer; callers keep layout,
including `@container/composer` on the group around the card. The shell owns
the composer's order relative to the transcript and app-wide layers; the card's
internal paint layers follow the local-isolation rule below. An existing
call-site `z-10` is not part of the surface contract or a pattern to copy.

### The composer's width

Every width-dependent utility inside the composer reads the composer, through
`composer-wide` — `@container composer (width >= 600px)` — and nothing else. A
chat panel beside the Cloud Browser is about 550px wide inside a 1600px window,
so a viewport breakpoint there keeps the full-width layout in a box that cannot
hold it, and controls that belong to the same row stop expanding at different
widths.

The variant is mobile-first and has no `max-` counterpart: compact is the base
style and a wider composer adds to it. Where a control simply runs out of room,
the footer wraps rather than taking a second breakpoint to squeeze it.

`@container/composer` sits on the group around the card, not on the card, so
the surfaces rendered beside it at the same width — the model-scope notice, the
pending-items strip — are inside it. Content portalled out of that subtree, such
as the template picker dialog and the model picker popover, is a different box
sized against the window and keeps viewport breakpoints.

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
class names.

The `--okou-card-*` variables are read directly by page-level surfaces — the
queue drawer's cards, the mail draft card, the onboarding pickers, and the
composer variant. They are not a supported API for a new surface; reach for
`surfaceVariants` instead. The chat transcript card reads its own
`--okou-chat-card-*` siblings.

### Menu and select rows

Every popup list draws one row height: 36px, the same figure `Button` ships as
its default size and `IconButton` ships as its square. `MENU_ROW_HEIGHT_CLASS`
in `components/ui/menu-row.ts` is its single owner — `min-h-9 py-1.5 text-sm` —
and `DropdownMenuItem`, `DropdownMenuSubTrigger` and `SelectItem` compose it. It
is a floor rather than a fixed height so a row whose label wraps or whose child
is taller than the line box grows instead of clipping, and a floor rather than
padding alone because padding expresses the height only in terms of the line
box: a caller passing `text-xs` would quietly draw a 32px row. A bespoke row
built on `Button` inherits the same 36px from `size="default"`; the model
picker's lists state it as `h-9` because each row is a fixed single line inside
a scroller.

Callers own the content, the icons and the horizontal rhythm — `px-*` and
`gap-*` stay adjustable, and a wide menu with avatars legitimately runs `px-3`.
Callers do not restate the height. `py-*` and `h-*` on one of those components
fork the row, which is what left the composer's `+` menu at 32px, the account
and workspace menus at 40px, the subscriptions reset action at 28px, and the
model picker beside them at 36px. `ccstate/menu-row-height` fails the build on
those utilities; `min-h-*` stays available to raise the floor for a deliberate
touch target, and the chat thread header's actions keep `min-h-11` on that
basis.

Two-line rows are a different control, not a taller menu row. The model picker's
type rail and its current-model rows pair a label with a summary line and state
their own `h-11` and `h-12`; they sit outside this contract because they are not
single-line list rows.

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

Visibility follows [Base UI's official Tailwind example](https://github.com/mui/base-ui/blob/v1.7.0/docs/src/app/%28docs%29/react/components/scroll-area/demos/hero/tailwind/index.tsx):
idle scrollbars are transparent and ignore pointer events; `data-hovering` or
`data-scrolling` makes them visible and interactive. `transition-opacity` fades
them out, while `data-scrolling:duration-0` reveals them immediately on scroll.
Base UI owns the interaction state and scroll timeout; the shared component
owns these visibility utilities alongside the shadcn geometry and colors.

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

The windowed popup's radius is `rounded-2xl`, and a layer inset from one of its
edges derives its own from that figure: inner radius = 16px minus the inset it
keeps. A layer sitting 8px inside the dialog therefore takes `rounded-lg`. Two
equal radii separated by a gap are not
concentric: the inner arc turns too late, and the corner reads as a mistake
rather than as a nested surface. A layer that meets the edge with no inset
keeps the dialog's own radius.

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

### Floating layers and portal ownership

Portals belong to the shared primitives. Business components must not import
`createPortal` from `react-dom`. `DialogContent`, `SheetContent`,
`PopoverContent`, `SelectContent`, `DropdownMenuContent` and `TooltipContent`
already own that relocation through Base UI's own `Portal`, together with the
focus, outside-press, scroll-lock and `aria` ownership that arrives with it.
The portal there is not a rendering convenience: it is what lets a layer escape
an ancestor's `overflow` clip or `transform` containing block, which is a DOM
constraint rather than a state-location one. The toaster is the one surface
that portals to `document.body` on purpose, because a toast outranks a dialog;
it lives in the primitive layer for the same reason.

An app-local surface renders in a stable host owned by the layout. An action
bar can use `sticky` to remain visible within its scrollport; sticky positioning
does not escape that scrollport's clipping or stacking context. A fullscreen
panel or cover needs a shell-owned host that can paint over every region it
covers. `fixed` changes positioning, but does not escape an ancestor's stacking
context. Establish the correct host before removing an existing portal.
Swapping a subtree between a portal and its written position remounts it, which
costs the scroll position and any DOM state it held.

Artifact list and preview fullscreen surfaces use the shared `FullscreenPanel`
primitive. It moves one stable portal container to `#root` in fullscreen and
back into its inline slot on exit, escaping the workspace stacking context.
The fullscreen surface participates in the isolated app root at `z-40`, above
workspace and sidebar content and below body-level Base UI dialogs and menus.
This also keeps it below the planned `z-50` primitives when root isolation is
removed. Business components do not own this portal or its stacking utilities.

Both modes render through the same portal container rather than switching
between a portal and an in-place React subtree. This preserves React state.
Native `moveBefore` also preserves scroll, iframe and media state; browsers
without it use `appendChild` with explicit scroll restoration, but embedded
frames/media may reload.

Reflowing Markdown previews opt into `FullscreenPanel`'s `scrollAnchor` contract.
The primitive captures the first visible content block and its viewport offset
before React changes the fullscreen styles, then restores that reading position
after moving the portal. It temporarily disables native scroll anchoring during
the commit so browser compensation cannot compete with restoration. Each toggle
captures the current reading position, including scrolling done in fullscreen.
Retaining a DOM node and its numeric `scrollTop` alone does not preserve a
document's reading position when its line wrapping changes.

Safe-area insets are the surface's own responsibility whenever it is `fixed`
and meets a viewport edge. `#root` carries the top and horizontal insets as
padding and delegates the bottom one, and a fixed box is laid out past that
padding box whether or not it was portalled, so "is it portalled" is the wrong
question and "is it fixed against an edge" is the right one.
[Page layouts](#page-layouts) registers the `p-safe` utility and the viewport
height tokens these surfaces take.

#### Stacking ownership

Business controls do not declare z-index. Icon buttons, menu triggers, cards
and other content must not choose their order against unrelated app regions.
A row's background already paints behind its children; a button does not need
`relative z-10` to sit above it. Event propagation is handled by event handlers,
not by raising the button's paint order.

- Shared floating primitives follow shadcn's flat `z-50` convention. Their
  portals and stacking utilities stay inside `@okouai/ui`; callers do not
  override them. Peer surfaces at the same stack level in the same stacking
  context follow DOM order, so preserve the primitive's portal structure.
- The shell owns app-wide non-portal layers such as drawers, scrims and
  fullscreen panels. Keep a small fixed set of literal Tailwind z-index
  utilities in shell-owned files, below the shared floating layer in the
  stacking context where they compete. Document each layer's host, the context
  it participates in and the siblings it must cover.
- Necessary overlap _inside_ a component is a local exception. Establish an
  explicit `isolate` host around the participating elements in the same change,
  and document why their order is needed. Keep the z-index inside that host;
  it must not rank the component against the shell. Prefer ordinary paint order
  when it already produces the intended result.

Use literal utilities at those owning layers. Do not introduce a parallel
z-index token ladder or component-local `--layer-*` variables. This is the
project's ownership convention, not a limitation of CSS custom properties:
Tailwind can express a variable-backed z-index, but neither a variable nor a
larger literal lets a descendant escape its ancestor's stacking context.

Audit the context, not a numeric threshold. A positioned `z-0` creates a
stacking context just as `isolate` does; transforms and opacity below 1 can
also create one. Review those boundaries before adding isolation to a layout
wrapper, especially when descendants need to cover other app regions.

The artifact bug recorded in
[#35387](https://github.com/vm0-ai/okou/issues/35387) illustrates the failure:
`WorkspaceInset` had `relative z-0`, trapping the artifact detail's
`fixed z-[100]` inside that context. The sidebar header's `relative z-10`
buttons participated outside it and painted above the fullscreen surface.
Lowering 100 below 50 or removing only `#root`'s isolation cannot repair that
boundary. The artifact catalog's portal to `#root` escaped it, so removing that
portal before correcting the host would expose the same bug on that path.

The primitive `z-50` restoration, root-isolation removal, shell-host migration
and z-index lint are tracked in #35387. Existing z-index declarations are
migration debt to audit under these ownership rules, including zero, negative
values and values below 50; passing today's lint does not establish correct
stacking. Regression coverage must verify that fullscreen content paints above
sidebar actions and that toggling fullscreen preserves the panel's DOM state.

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

`--border-width-annotation-box` (2.5px) sits in the same App layer for the same
reason: an image annotation is the user's drawing on top of a screenshot, so its
outline is part of the picture rather than product chrome. It is registered
despite being read from a `style` prop, because the mark's colour is a genuine
runtime value — the component composes the colour, the system still owns the
weight. The numbered pin beside it is chrome laid over artwork, not a drawing,
so it takes the shared `--border-width-emphasis`. Do not collapse the two: a
drawing tool's weights must be free to move without touching product chrome.

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
`@layer utilities` and declares no class selector, so the policy does not see a
selector to reject.

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
class: a class in the selector is a first-party class-selector declaration, and
the document-level selectors that spell it are allowlisted rather than
exemplary.

Consumers spell `before:bg-[length:100%_100%]` beside the two background
utilities. `background-size: 100% 100%` and the initial `auto auto` size a
gradient to the same box, so it is a stated rather than a load-bearing value.

Chrome inside the pane lets that canvas through. The thread header, the chat
composer's footer, the sharing bar and the shared thread's handoff bar all stay
transparent; only the cards inside them carry a fill. A pane-width surface that
paints `--background` instead assumes the canvas is a flat fill of that colour,
which holds in the neutral themes and does not under a gradient palette, where
the canvas is `--card` plus two corner gradients: the composer footer used to
paint `--background` and ended in a visible band across the pane in every dark
palette. A surface that genuinely has to cover the canvas — the transcript's
loading overlay — takes `bg-workspace-canvas` so it covers with the canvas's own
fill.

Softening the transcript's bottom edge belongs to the transcript, for the same
reason: a gradient painted over the pane can only fade toward one flat colour.
`CHAT_THREAD_SCROLL_EDGE_FADE_CLASS` masks the scroll viewport instead, so the
content fades and the canvas behind it is left untouched in every theme.

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
policy nor `no-unknown-classes` counts them — the policy only counts the tokens
the allowlist names, and the rule reads class attributes only. Page tests that
query `code.language-mermaid` likewise match
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

They are recorded in three shapes: a `selectors` entry for a CSS rule, a
`styleInjections` entry for an injected stylesheet, and a `classDependencies`
entry for a class a component must put on an element because a third party's
DOM contract keys on it. A `vendorFiles` entry pins a whole vendored stylesheet
by hash.

Hosted Clerk authentication does not use a third-party DOM adapter. It stays on
Clerk's public appearance API under the narrower rules in
[Clerk customization](./clerk-customize.md).

Every exception identifies the exact file and selector or injected-style
fingerprint, its owner, rationale, and removal condition. Third-party adapters
also identify their upstream DOM owner. A styling convenience, missing utility,
or existing first-party convention is not an exception. Vendored CSS is pinned
by exact path and SHA-256 rather than by a directory-wide ignore.

A `selectors` entry matches exactly: the file, the enclosing conditional
at-rules, the nested selector ancestry, and the selector itself all have to
agree, so the same rule moved under a different media query is a different
selector. Normally only a rule that spells a class needs an entry, but a
class-qualified `@scope` qualifies every declaration inside it, so its `:scope`,
`&`, and bare element rules count as first-party class declarations too. Any
first-party class-selector rule the allowlist does not name fails lint — there
is no grandfathered set behind it. The check runs both ways: an entry that no
longer matches a rule also fails, so removing the CSS means removing the entry
in the same change.

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

`toaster` in `components/ui/sonner.tsx` is the mirror case. Sonner neither
defines nor requires that class; the component invents it, hands it to Sonner's
`className` prop, and then anchors its own `group-[.toaster]:` variants on it.
Sonner's actual contract is the `[data-sonner-toaster]` attribute it puts on its
own list element. It and `wmde-markdown` in `markdown-frame.tsx` are the two
`classDependencies` entries in `turbo/style-allowlist.json`, which is where a
class carrying a third party's DOM contract belongs; neither is expected to go
until its renderer does.

An entry authorizes a count in a file, not a class. A second use in the same
file fails lint, any use in another file fails, and so does a count that has
fallen — lower it in the allowlist, or delete the entry. Uses are counted at the
consuming attribute or call, resolving local constants, imported aliases, and
re-exports, so passing an already-authorized constant to a second component is a
new dependency rather than a free one. A class a first-party element invents for
itself is not this kind of exception, however vendor-like the name reads — the
borrowed-name rule above is what separates the two.

## Enforcement and feedback

Run the complete check from `turbo`:

```bash
pnpm lint:style
```

The check has three layers:

1. The repository policy checks every first-party CSS class-selector
   declaration, class dependency count, injected-style fingerprint, and vendored
   file hash against `turbo/style-allowlist.json`, and validates that the
   allowlist's own entries carry their required metadata.
2. `@eslint/css` parses first-party CSS with Tailwind v4 syntax and disallows
   inline ESLint configuration for this check.
3. `eslint-plugin-better-tailwindcss/no-unknown-classes` validates component
   class strings against the real App Tailwind entry point, ignoring only the
   allowlisted class dependency tokens.

The policy needs no Git history and no reference commit: the allowlist is the
whole expectation, so the same command gives the same answer on a branch, in the
merge queue, and on a contributor's machine. An unreadable or malformed
`style-allowlist.json` fails it outright.

CI runs this as the independent required `lint-style` job. The pre-commit hook
runs the fast repository policy so the most actionable boundary failures are
returned before push. Both policy diagnostics and the full lint command's
failure output direct contributors to `docs/styles.md` for the style guide. The
full command keeps a failing exit status for policy, CSS, Tailwind, or test
failures.

Z-index ownership enforcement is planned in
[#35387](https://github.com/vm0-ai/okou/issues/35387) and is not yet part of these
checks. It must cover numeric, negative, arbitrary and variable-backed z-index
utilities (including variants), arbitrary `z-index` properties and inline
`zIndex`, rather than only values at or above 50. Each permitted declaration
must identify its exact file, owner, rationale and stacking host; a local
exception must name its `isolate` boundary. Static lint cannot prove the runtime
ancestor chain or paint order, so it complements the fullscreen regression
coverage described above. Do not assemble class names dynamically to evade it.

When a style check fails, read this guide and replace business styling with the
appropriate Tailwind utilities and registered tokens. When a change removes CSS
or a class an entry covers, remove that entry in the same change. Do not
suppress the check or add a business styling exception to make it pass.

## App palette previews

`bg-palette-anchor bg-palette-gradient` renders the color-theme anchor and its
fixed companion gradient. These App-owned domain utilities use `@theme inline`
so each element resolves its own `data-color-theme` anchor/companion instead of
inheriting the selected document palette. The 135-degree gradient and 52% sRGB
midpoint are identical in Light/Dark; consumer geometry stays at the call site.
