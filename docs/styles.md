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

Borders and rules are separate decisions with separate tokens. `--border` is for real borders, which follow `--default-border-width`. `--divider` is the lightest neutral rule — separators, `h-px` / `w-px` hairlines painted as backgrounds, and resting rail ticks. Those are sized explicitly, so they never lost thickness to the border hairline and must not inherit its compensating darkening. Use `bg-divider` for a painted rule and `border-border` for an actual border; do not reach for a raw ramp stop such as `border-gray-200` for either, because that bypasses both decisions.

Color-theme presets in the App stylesheet share their anchor and companion colors between picker swatches and workspace ambience. Daydream uses cool blue and violet, while Cotton sky uses pastel pink and blue. Each preset's hue and ring values keep semantic surfaces, selected states, and focus indicators aligned with that palette in Light/Dark.

When `GradientColorThemes` is enabled on the document, each preset's HSL primary value supplies both its anchor color and the shared `--primary` token. Primary actions, including portaled dialog buttons, immediately use that fill and the preset's contrast-checked `--primary-foreground` in Light/Dark. Hover and pressed fills blend the anchor toward its companion using the existing filled-state alpha tokens. Disabled buttons retain the shared opacity treatment. Removing the document's color-theme attributes restores the shared Amber primary tokens.

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

The `okou-badge`, `okou-pill`, and `okou-border-r` selectors and their consumers have been removed. `okou-pill` was scoped to `.okou-app` and set the muted foreground; its only consumer now spells that foreground itself. `okou-border-r` was a single settings-dialog divider and became `border-r border-r-gray-300` on that nav, keeping its lighter Gray 300 stroke while its width joins the shared hairline token.

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

The `icon-button` and `dialog-scrollable` selectors and their dependencies have
been removed. `icon-tooltip-trigger` remains scoped to the third-party Mermaid
block and migrates with that adapter.

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

`--mic-volume-fill` stays a component-set runtime value, read through
`after:h-[var(--mic-volume-fill,0%)]`.

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

The neutral button adds the existing outline interaction fills
(`hover:bg-state-hover active:bg-state-pressed`) to the shared surface, keeping
the hover overlay above those fills. Select triggers retain the opaque surface
and hover overlay. The existing recovery links and Add automation trigger
preserve that same interaction treatment with `hover:bg-control-surface
active:bg-control-surface` on their `Button` instances.

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
