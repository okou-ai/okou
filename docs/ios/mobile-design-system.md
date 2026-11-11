# Okou Mobile Design System

This is the design authority for first-party iOS UI. Its executable foundations
and reusable primitives live in [`ios/Okou/DesignSystem`](../../ios/Okou/DesignSystem).
New screens and design revisions start here. Web owns shared brand/color
definitions; Mobile owns native geometry, component composition, and interaction
adaptation. A component uses semantic roles rather than choosing palette stops
independently in each screen.

## How the system is organised

The system has three layers, in the order Apple's Human Interface Guidelines and
Material 3 use: foundations, then components grouped by what they do, then patterns.
The source folders, the Debug catalog's pages and this guide follow the same groups, so
a component is in the same place in all three.

| Layer       | What it holds                                                  | Code (`ios/Okou/DesignSystem/`)                                                                                              | Catalog pages                                        |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Foundations | Color, type, layout and motion tokens, icons, materials, brand | `Foundations/`                                                                                                               | Color, Typography, Iconography, Materials & surfaces |
| Components  | Reusable views, grouped by what they do                        | `Components/Actions`, `SelectionAndInput`, `ListsAndRows`, `NavigationAndSearch`, `StatusAndFeedback`, `Content`, `Identity` | One page per group                                   |
| Patterns    | The product's assemblies of components on its screens          | The owning feature in `Features/`                                                                                            | Chat, Sidebar, Sign-in & account, Connectors         |
| Catalog     | The Debug-only reference itself                                | `Catalog/`                                                                                                                   | The index                                            |

- A component goes in the group for what it does, not for the screen that first used it.
  One file holds one component family; a file that gains a second family is split.
- Patterns have no code of their own in `DesignSystem/`. A reusable piece of a pattern
  becomes a component in its group first.

## Sources and ownership

| Layer                                    | Authority                                                                                      | Native consumer                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Shared colors, light/dark, state layers  | [`globals.css`](../../turbo/packages/ui/src/styles/globals.css), exported `--color-*` bindings | `OkouColor.generated.swift`                                    |
| App font family and sidebar-border alias | [`index.css`](../../turbo/apps/platform/src/views/css/index.css)                               | Geist / Geist Mono; generated sidebar-border                   |
| Native geometry and motion               | `OkouMetrics.swift`                                                                            | `OkouSpace`, `OkouRadius`, `OkouControl`, `OkouMotion`         |
| Typography and scaling                   | `OkouTypography.swift`; licensed fonts in `Resources/Fonts`                                    | `Font.okou`, UIKit font adapter                                |
| Product icons                            | Web's pinned `lucide-react`; matching official `lucide-static` vectors                         | `icons.json`, generated assets, `OkouIcon`                     |
| Product brand assets                     | Existing `OkouMark`, wordmark, and assistant avatar asset sets                                 | `OkouBrand`, `OkouWordmark`                                    |
| Common components                        | `DesignSystem/Components/<group>/`                                                             | Buttons, fields, surfaces, empty states, auth theme            |
| Feature composition                      | The owning feature                                                                             | Chat cards, composer, sidebar, attachment and permission views |

Brand artwork retains its approved shape, aspect ratio, and colors. Do not
redraw logos with generic icons. Preserve multicolor partner/connector identities
and their own licenses; the Lucide template pipeline is for product interface
icons, not replacement partner logos. Add new assets to the owning catalog and
reference their semantic name through the shared layer.

## Principles

Okou is warm, clear, and capable. Preserve the Web's Amber/Ink action pair,
Geist typography, Lucide artwork with native optical weight, wordmark, and default assistant artwork.
Quiet neutral surfaces let work and agent identity lead; amber identifies a
primary commitment, rather than decorating every control. Do not substitute a
competitor's primary palette, typeface, illustrations, or brand motion.

Interaction conventions are references, not visual templates. Use a bottom
composer and predictable navigation; group related tools behind one entry and
keep the send/stop action immediately available. These principles are informed
by [ChatGPT's conversation flow](https://mobbin.com/flows/8fb44197-0185-4f58-8f73-9ac86fc3d378),
[Claude's model and tool flows](https://mobbin.com/apps/claude-ios-d4f0ada4-3325-4c8e-9c3e-1115dbd469c9/754cdd57-a1c5-4553-b8fa-1c3c4eba8b2e/flows),
[Manus's task flows](https://mobbin.com/apps/manus-ios-5a1953a4-1dcd-4a22-a486-612735a15ef7/5aff77ed-6c06-428d-baf7-0e2c303374ca/flows),
[Perplexity's search and chat flows](https://mobbin.com/apps/perplexity-ios-87417f94-f7ac-487f-a94e-8e4472612f1e/8b7c170f-2328-5cfc-b048-ee0c4b8b6171/flows),
and [Apple's material guidance](https://developer.apple.com/design/human-interface-guidelines/materials).
Competitor screenshots do not establish exact point sizes or opacity values.

## Foundations

Tokens every component is built from, in `DesignSystem/Foundations/`.

### Color

These rules follow actual shared Web components and their consumers, including
[`button.tsx`](../../turbo/packages/ui/src/components/ui/button.tsx),
[`input.tsx`](../../turbo/packages/ui/src/components/ui/input.tsx),
[`card.tsx`](../../turbo/packages/ui/src/components/ui/card.tsx),
[`chat-composer.tsx`](../../turbo/apps/platform/src/views/okou-page/chat-composer.tsx),
[`chat-message-surface.tsx`](../../turbo/apps/platform/src/views/okou-page/chat-message-surface.tsx),
and [`sidebar-threads.tsx`](../../turbo/apps/platform/src/views/okou-page/sidebar-threads.tsx).

| Use                                         | Web role                                                     | Mobile role / rule                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Page canvas                                 | `background`                                                 | `OkouColor.background`                                                                                      |
| Cards and large composer surfaces           | `card`, `card-foreground`, `border`                          | Same semantic roles; use `OkouSurfaceStyle` for general cards                                               |
| Main copy / supporting copy                 | `foreground` / `muted-foreground`                            | Same roles; supporting text does not become disabled opacity                                                |
| Brand CTA and Send                          | `primary` + `primary-foreground`                             | Amber fill with Ink label in both schemes; never white on Amber                                             |
| Brand links and textual emphasis            | `brand-text`                                                 | Not used natively: it reads brown. Text actions and links are ink, card glyphs `muted-foreground`           |
| System tint (caret, alert actions, menus)   | `foreground`                                                 | `AccentColor` is neutral ink, never brand-text; an alert's filled Save is ink in light, `gray500` in dark   |
| Markdown/content hyperlinks                 | `link`                                                       | Blue content links; distinguish them from brand navigation/actions                                          |
| Neutral standalone controls                 | Web `outline` button: `background`, `gray-400`, `foreground` | `OkouButtonStyle(isPrimary: false)`; not `control-surface`, whose warm gray-50 read as pink on white cards  |
| Toolbar/composer utility icons              | Web `quiet`: `muted-foreground`                              | Neutral glyphs; brand color is reserved for action emphasis                                                 |
| Selected switch                             | Shared Switch uses `primary-400` with a white thumb          | Native switch tint `primary400`; retain the native thumb and interaction                                    |
| User-message bubble                         | `gray-200`, `foreground`                                     | Same roles, including the send-motion surface                                                               |
| Sidebar canvas and copy                     | `sidebar`, `sidebar-foreground`                              | Same roles; not the page canvas                                                                             |
| Selected navigation row                     | `state-selected`, `sidebar-foreground`                       | Translucent state layer over the sidebar; do not substitute an opaque muted fill                            |
| Input resting edge / fill                   | `gray-400` / `input`                                         | `controlBorder` / `input`; placeholder uses muted text                                                      |
| Field focus                                 | Shared Input uses `primary` edge and `primary/10` ring       | Primary focus edge; keep native keyboard/focus ownership                                                    |
| Large composer focus                        | `surface-focus` edge                                         | Strengthen existing edge rather than adding a second large ring                                             |
| Standard boundary / boundary on a fill      | `border` / `border-on-fill`                                  | Match the role; do not fade every border independently                                                      |
| Stop active work                            | `interrupt`, `interrupt-foreground`                          | Coral stop glyph button; interruption is resumable                                                          |
| Delete / invalid input / operation failure  | `destructive`, `destructive-foreground`                      | Use destructive semantics and preserve native destructive action roles                                      |
| Pressed filled action                       | `primary-pressed`, `interrupt-pressed`, etc.                 | Generated sRGB mixed colors; avoid opacity on the entire active control                                     |
| Pressed neutral / selected / nested surface | `state-pressed`, `state-selected`, `nested-fill`             | Generated alpha layers placed over an existing surface                                                      |
| Disabled / pending                          | Web components own disabled/pending behavior                 | Disable repeated actions, retain the accessible label, use loading progress; disabled visual opacity is 0.5 |

Colors are generated in sRGB with independent light/dark values. Raw `white` and
`black` Web tokens invert with the theme: media overlays instead use the fixed
`OkouMediaColor` pair. Do not treat palette ramps as semantic roles. Web's optional
user-selected color palettes and custom navigation presets are not currently
synced to native preferences; the native mapping follows the default product
palette and the device color scheme.

### Typography, layout and motion

All geometry is measured in points. Values are Mobile design choices; they are
not copied from CSS and are not all mandated by Apple.

| Foundation   | Rule                                                                                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typeface     | Geist for UI, Geist Mono for code; system fallback covers unsupported scripts                                                                                                                                                                                                                                                     |
| Type scale   | Large title 34, title 28, title2 22, title3 20, body/headline 17, callout 16, subheadline 15, footnote 13, caption 12, caption2 11                                                                                                                                                                                                |
| Text scaling | Use `Font.okou(.body)` and corresponding named styles. A fixed `size:` is only for already scaled measurements or constrained artwork; ordinary body text uses Dynamic Type                                                                                                                                                       |
| Spacing      | Prefer 4, 8, 12, 16, 20, 24, 32, 40, 48 via `OkouSpace`; smaller named steps serve tight component internals                                                                                                                                                                                                                      |
| Radius       | Inline code 4, thumbnail 6, small 8, control 14, chat 16, card 20, sheet 28; circles/capsules remain native shapes                                                                                                                                                                                                                |
| Type roles   | One surface uses at most three sizes: body 17 for content and input, callout 16 for controls inside the composer (subheadline 15 for its model value, under the draft), footnote/caption for supporting text. Never shrink a control label below callout to make it fit                                                           |
| Controls     | Minimum interactive area 44 (`minimumTarget`); large form control 52; sidebar row 48; grouped row 52 (`groupedRow`); inline content action 36 tall × 44 wide; status column 22; filter chip 36; catalog logo tile 44 / 64 with a 32 pt add control; dictation waveform 28 tall (3 pt bars, 2 pt gaps); labels can grow vertically |
| Layout       | Page inset 24 (`pageInset`) is the one leading edge for a screen's header, section headings, rows and footer; readable single-column width 440; respect safe areas and keyboard avoidance                                                                                                                                         |
| Icons        | Canonical Lucide 24-unit paths; native 2-unit stroke. Compiled image intrinsic size is 20 pt for system menu hosts. Explicit SwiftUI geometry follows the role table below.                                                                                                                                                       |
| Motion       | Press feedback 150 ms, ordinary transition 250 ms; honor Reduce Motion; product-specific motion is ported from Web with its timing as `OkouMotion` tokens (greeting words, running cycle, 1.5 s working shimmer, fold spring, 50 ms waveform sample; navigation transitions are system-owned)                                     |
| Elevation    | No shadows on in-flow content. Only surfaces floating over content (suggestion panels) take `OkouElevation.floating*` (8 % black, radius 16, y 6)                                                                                                                                                                                 |
| Haptics      | `sensoryFeedback` only for committed moments: send (light impact), stop (medium), success of a copy/approval/send, error, sidebar open/close (selection). Never on scroll or typing                                                                                                                                               |

An icon inside a `Label` is decorative: its text names the action. Icon-only
buttons require an explicit accessible label. Errors appear next to the owning
input/action and retain an accessible explanation. Keep keyboard type, content
type, autofill, IME composition, focus restoration, and native dismissal behavior
with their owning input/controller.

### Iconography

Native icon calibration is the sizing reference. Compare custom artwork with
SF Symbols inside the same actual native control, at the same text size and
appearance. A 24-unit SVG viewBox is a drawing coordinate system, not a required
24 pt display size. The line weight and drawn bounds matter alongside the box.

| Role                                 | Token                                 | Native use                                                                        |
| ------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------- |
| System menu image                    | `menu` 20 pt                          | Intrinsic size of compiled UIKit/SwiftUI menu images; the native menu owns layout |
| Icon-only toolbar/composer action    | `toolbar` 20 pt                       | `OkouToolbarIcon`, in a separate minimum 44 pt action area                        |
| Labeled body/list row                | `standard` 20 pt                      | Settings, connectors, ordinary body labels                                        |
| Supporting inline/status label       | `inline` / `reference` 16 pt          | Caption/footnote status, reference chips, secondary inline information            |
| Disclosure/accessory                 | `accessory` 16 pt                     | A small hint beside a full labeled action, never a standalone button              |
| Warning badge                        | `badge` 14 pt                         | Small overlay attached to a correctly sized action                                |
| Feature illustration / media overlay | `large` 24 / `mediaOverlay` 32 pt     | Card or media artwork, distinct from navigation                                   |
| Empty state / document preview       | `emptyState` 40 / `filePreview` 48 pt | Content placeholder artwork, never menu icons                                     |

- `OkouToolbarIcon` caps artwork scaling at XXXL to fit native action geometry;
  text and native menu labels retain full Dynamic Type. Glyph size and touch
  target size are separate choices; do not enlarge glyphs to obtain a 44 pt target.
- Resting navigation uses neutral `foreground`; brand/selected emphasis has a
  separate color role. Never tint icons, links or text actions with `brand-text`.
- Native UIKit menus consume the image's intrinsic dimensions. SwiftUI frame
  modifiers and SF Symbol configurations do not resize a custom UIImage there.
  The asset generator therefore emits `width="20" height="20"` while preserving
  `viewBox="0 0 24 24"` and the canonical vector paths. Do not pass uncalibrated
  raw 24 pt assets into `UIAction` or repair each menu with a different thumbnail.
  The manifest owns any per-glyph optical correction: the outline `pencil` uses
  0.8 scale around the viewBox center to match native pencil footprint. Its source
  paths remain unchanged, and the scaled group's stroke is widened by 1/scale so the
  drawn line keeps the set's 2-unit weight beside unscaled glyphs (a pencil next to a
  pin must not look like another icon set). Do not scatter scaleEffect adjustments
  across features.
- Use named roles throughout features. Keep larger card/media placeholders and
  small inline accessories intentional; they are not exceptions to fix by a
  global scale multiplier. Caption labels explicitly request an inline icon.
  Chevrons and diagonal external-link arrows use a 16 pt canvas because their
  paths occupy about half the viewBox; a 12 pt canvas makes the drawn hint tiny.
  Stop uses a 16 pt square, matching the smaller footprint of a native stop glyph,
  while send retains the calibrated toolbar arrow.

### Materials and surfaces

- **Page** canvas is `background`, pure white (`#FFFFFF`) as on the web, where the canvas
  carries no tint; cards and sheets in the page are white too. The **sidebar** is
  `sidebar` (gray-50), the web's warm chrome.
- **Fills on white are neutral.** The warm `muted` and `control-surface` read pink on `card`
  and `background`; tiles, placeholders, media backdrops, zebra rows and tracks use the
  `state-hover` or `nested-fill` layers instead.
- **Glass controls** use `OkouGlassControl`: native `.glassEffect(.regular.interactive())`
  drawn on an exact 44 pt shape — `.circle` for a single glyph (the chat's menu),
  `.capsule` at the same 44 pt height for a labeled control or a group (the sidebar's search
  field; its chat list menu and back, which share one capsule). Every bar control is the
  same clear glass, the sidebar's new chat included —
  no dark-tinted "prominent" circle. `.buttonStyle(.glass)`
  drew a ~35 pt circle inside its 44 pt frame and looked smaller than the UIKit glass
  "…" menu beside it. UIKit menu entries keep `UIButton.Configuration.glass()`, unless a
  glass group draws the glass around them (the sidebar's chat list menu is `.plain()`).
  Paired controls in one bar are the same size.
  The sidebar filter uses `ChatListFilterMenu` with that native configuration so
  `SidebarMenuButton` can suspend page swipes through the menu's dismissal
  animation, until UIKit has returned the lifted button to its source.
- **Floating panels** over the transcript (slash workflows, @mentions) use
  `OkouFloatingPanelStyle`: the same card, card radius, plus the floating shadow.
  Not `.regularMaterial` — a grey material block did not match the rest of the UI.
- **Grouped sheets** (Settings, models, connectors, subscriptions,
  usage) all use `okouGroupedBackground()`, which owns everything a grouped sheet
  shares, so no sheet can drift:
  - the system grouped background with the system's white rows (the product grey ramp
    is warm and read as pink behind white rows);
  - an opaque `presentationBackground`: at a partial detent an iOS 26 sheet is glass
    and the system turns grouped rows grey, while full height they are white;
  - the soft blur under the title bar and none at the bottom (sheets do not inherit the
    root's style);
  - an 8 pt top content margin, so the first card starts just under the title bar.
- **A sheet's ground is set at its root.** Every sheet that shows grouped rows gets
  `okouSheetBackground()` on the view it presents, next to `presentationDetents`, so a
  partial detent stays opaque with white rows instead of glass with grey ones. Set from
  inside the sheet's `NavigationStack` (as part of `okouGroupedBackground()` once was), the
  ground reaches the sheet after its slide has begun: the sheet appears in place and only
  its rows slide up.
- **Edges under bars**: the top scroll edge defaults to native `.soft` and the bottom
  edge is hidden everywhere (`OkouAppearance`, and `okouGroupedBackground()` for sheets).
  Content passes plainly under the composer, the sidebar footer and other floating
  controls, which carry their own glass. Where a custom bar's text sits over scrolling text
  at the top, the edge must hide it:
  - The chat transcript uses the system's `.soft` top edge, the progressive blur ChatGPT
    and Manus draw: strongest at the screen's edge, clearing toward the content, with no
    colour of its own. Its reach follows the safe area. The header and composer heights are
    `contentInset`s, so the top edge blurs only the status bar band and text under the
    header's glass controls stays sharp. Putting the header in the safe area (as the
    redesign once did) blurs the whole header, a band far too tall. Its bottom edge is
    hidden (`bottomEdgeEffect.isHidden`).
  - Never draw an edge blur by hand. A `UIVisualEffectView` has one radius for the whole
    band, so masking it to fade reads as a hard, opaque strip, and every blur style tints
    a dark page grey. Only the system edge effect blurs progressively.
  - The sidebar's top is the system's `.soft` edge under its header bar, as Slack draws
    it: rows blur away under the glass buttons. The workspace name would sit over chat
    titles there, so it fades out (`OkouMotion.transition`) as soon as rows scroll under
    the bar and comes back at the top. Its bottom edge is hidden like the rest, so rows
    pass plainly under the footer.
    Verify both themes with text scrolled under each bar after changing either.
- Do not replace native Glass, Blur or safe-area bars with opaque cards, arbitrary
  opacity fills or custom outlines. Follow Reduce Transparency and Reduce Motion.

## Components

Reusable views, grouped by what they do. Each group is a folder in
`DesignSystem/Components/` and a page in the catalog.

### Actions

- **Buttons**: `OkouButtonStyle(isPrimary:)` is a filled primary or the web's outline
  button. `isCompact` (15 pt, 44 pt tall, one line) fits two actions side by side on a
  card; the default size is for one full-width action.
- **Compact buttons** carry `OkouCompactButtonLabel` (16 pt glyph, 6 pt gap) so two
  side-by-side actions keep their whole titles. A full-size `OkouButtonStyle` is for a page's
  one main action (sign-in); inside sheets and cards actions are compact.
- Viewing sheets and immediately applied settings use `OkouCloseButton`. Use Done
  for a completed operation or choices a sheet drafts (the model sheet, whose ✕ drops
  them), Save for an explicit commit of edited content, and Back within a sheet.
  Do not imply a pending save where selections already apply immediately.
- **The close button has one place**: the trailing end of the toolbar, after the screen's
  own actions, on every sheet and full-screen viewer (`OkouCloseToolbarItem`; never
  `.cancellationAction` or the leading side). The system's own pickers (Photos, Files)
  keep theirs.
- **Swipe-action fills** (`OkouSwipeTint`) carry the system's white label in both
  appearances and say what kind of change it is: `neutral` (brand dark grey) for moving a
  chat, `readState` (the unread dot's sky blue) for read state. Never amber or the warning
  orange.

### Selection and input

- **Value pickers** (Thinking effort, Appearance, Allow for, Category, Method) use
  `okouValuePicker()`: menu style with the value and chevron in `muted-foreground`.
  The app's global `foreground` tint otherwise drew the value as heavy as its label.
- **Directory controls** (`OkouSegmentControl`, `OkouChip`, `OkouLogoTile`,
  `OkouAddIndicator`) keep iOS sizes and shapes and take
  their colours from the web directory's tokens (`connector-directory-dialog.tsx`,
  `connector-card.tsx`, `segment-control.tsx`): no black fills, since black is never a
  selection colour here, and a primary action is amber.
  - `OkouSegmentControl` switches what a page lists (Discover / Custom): the large
    segmented shape — a full-width 48 pt capsule with equal segments, the selected one
    inset 2 pt — in `segment-track`, with the selected segment raised in
    `segment-selected` and the web's soft shadow; 15 pt medium labels, supporting text
    when not selected.
  - `OkouChip` in an `OkouChipRail` for filters that scroll sideways: 36 pt capsules in
    `gray-50` with a `gray-400` hairline and supporting text; the selected chip takes
    `state-selected` and the text colour, at the same weight.
  - `OkouLogoTile` (44 pt on a card, 64 pt on a detail page, `state-hover` fill and a
    hairline, corner 27 % of its size) so logos of any shape line up.
  - `OkouAddIndicator`, the card's trailing 32 pt control: "+" in an outlined square
    adds without opening the item; once added it is a chevron with no edge and the
    whole card opens the item.
- **Placeholders** (the composer's "Message Okou", the sidebar's "Search chats" and its glyph)
  use `OkouColor.placeholder` (gray-600), lighter than supporting text.

### Lists and rows

- **Section headers** use `okouSectionHeader()`: 15 pt medium `foreground`, sentence
  case; a provider header adds its logo before the same text. Never the inherited
  17 pt body.
- **Section footers** use `okouSectionNote()`: 13 pt `muted-foreground`. A control's
  explanation (effort, scope of a switch) goes in the footer under its card, never as a
  row inside it — the system Settings pattern. One footer per card. A menu's own options
  explain themselves in the menu instead: the model sheet's Fast cost heads its menu.
- **A row's current value is a step lighter than its label.** Trailing values — a picker's
  value and chevron (`okouValuePicker()`), a value row's "On" or "English"
  (`OkouValueRow`) — use `OkouColor.trailingValue` (gray-700): visibly lighter than the
  `foreground` label and than supporting text, as Settings draws them, but still AA on
  white. Never the placeholder grey (gray-600): a value is content, not a hint.
- **A chat row's quiet marks** — the status column's chat glyph, the draft pencil, a
  section's fold chevron — use `OkouColor.quietMark` (gray-500), so they sit well behind the
  titles as the web's faded sidebar glyphs (35–70 % opacity) do. That is under 3:1 on the
  sidebar, so a mark never carries meaning alone: the pencil has its VoiceOver label ("Draft")
  and the fold its heading's value.
- **One text edge and one row height for the whole app.** Grouped rows never set
  their own height; `okouGroupedBackground()` sets the minimum to 52 pt
  (`OkouControl.groupedRow`), the height the system gives a row with a 28 pt icon
  slot or a switch, so a row of text alone (a model, a subscription) is exactly as
  tall as Settings' rows and Thinking effort beside it. A row that is one whole
  button (a model choice) drops the system's vertical padding and takes the 52 pt
  itself, so the full row is the target; it never sets a smaller height. A row with a leading graphic (icon, partner logo, avatar,
  workspace mark) uses `OkouRowLabel`, which centres the graphic in the 28 pt
  `rowLeadingSlot`, so text starts on the same edge in every row and sheet. A sheet
  either gives every row a leading graphic (Settings, Connectors) or none (models,
  subscriptions); provider logos then live in the section headers.
- **One separator style per card.** Rows with a leading icon and rows without one
  inset their separators differently; do not mix them in one card. Options of a
  selection (Thinking effort, Speed) share a card with the row that opens the list they
  configure, as the model sheet's form does.
- **Action rows in lists** ("Use for new chats too", "Open Okou on web", "Connect …")
  are `foreground` text with a leading icon. Amber is for a filled primary commit
  (send, a card's `.primary` action), never for list text. The model sheet's Set as default
  is a commit of its own with no icon: medium-weight `foreground` in a card of its own, so it
  reads apart from the options above it.
- **Rows** share one layout: optional status column, title (body, one line), trailing
  state. The status column holds the web's title status emoji (✅ Done, ⏳ Waiting, …);
  it appears in a section only when one of that section's chats has a status, and
  rows without one show a quiet `message-circle` glyph so titles stay on one edge.
  The emoji stays in the title so web and iOS agree; archive is a separate flag.
- **Working** shimmers the chat's title (`OkouShimmerText`) instead of taking the trailing
  slot, so a working chat keeps its draft in view. A folded project's name shimmers only
  when one of its chats works and none is unread; unread takes priority.
- **Trailing state** shows one state, in the web's order: an unread dot (8 pt `running` sky
  blue, as on the web; amber is kept for a primary commit) once a run finished or failed since
  the chat was read, with the title in medium weight; a `pencil` for an unsent draft; the
  resting `pin` of a pinned chat; or nothing. The pin outlasts the other states, so the row's
  accessibility value says "Pinned" rather than the mark. The pencil and the pin are 20 pt in
  `OkouColor.quietMark` (gray-500), as is the status column's
  quiet chat glyph, so a row draws one line weight (a glyph's stroke grows with its size);
  every trailing mark is centred in one 20 pt column so they line up down the list. A chat still in memory takes its
  draft from its own composer, so leaving it with text typed marks it at once; other chats use
  the API's draft list (`/api/chat-thread-drafts`). Status is never a system spinner.
- Provider headings separate identity from allowance; do not
  shrink or truncate allowance text to fit beside a brand name.

### Navigation and search

- **One icon set, system buttons included.** The system back button keeps its native
  behaviour but draws Lucide `chevron-left` (`OkouNavigationBar.applyBackIndicator()`, set
  once at launch): Apple's SF chevron was half again as tall and heavier than the Lucide
  glyphs beside it, so a pushed page's Back never matched the header's menu or the ✕.
- **A menu opens from what it is attached to.** A `Menu`'s label is only as wide as its
  own content (the sidebar's chat list menu is its own 44 pt button inside the header's glass
  group); a row that needs the full width widens
  outside the `Menu`. A full-width label makes the system open the menu from the middle
  of the row.
- **Search opens in a native sheet**, sliding up like the app's other sheets. Use a large
  detent to leave room for results above the keyboard, a visible drag indicator, and the
  trailing close button. Set `okouSheetBackground(OkouColor.background)` at the sheet's root.
  `OkouSearchPage` owns the shared search surface; its header, filters and results share
  `OkouColor.background` in light and dark appearances, with transparent list-row backgrounds.
  - Opening search focuses the native field during the sheet's incoming transition. Focus
    belongs to the search presentation, not a query or filter update; dismissing the keyboard
    while browsing results must not cause it to open again.
  - The field and filters stay at the top whether the keyboard is visible or not. Use
    `OkouSearchField` (a native `UITextField`) inside the shared `OkouSearchBar` capsule,
    with Lucide `search` in placeholder grey. Keep editing, marked text, selection and
    Dynamic Type native; request initial focus in `viewIsAppearing`, not after presentation.
  - It has no clear button: the trailing `OkouCloseButton` in a glass circle closes the
    entire sheet in one action, including while editing. Do not use a search controller's
    cancel button as a page close. The keyboard's Search action only ends editing and
    preserves the query and results; neither action moves the header.
  - Nothing matched, and a scope that only searches once something is typed (Messages,
    Artifacts), is one `OkouEmptyState` for the page, never a bare line of text. It sits
    over the list, centred in what is left of the screen: under the filters and above the
    keyboard, recentring as the keyboard goes down. A section shows only when it has rows,
    so no title stands over an empty one.
    The field and the filter row sit on a solid page-coloured header (`.hard` top scroll
    edge, the filter row in a `safeAreaBar` with the page colour), so results end cleanly
    under it instead of blurring through, as ChatGPT, Claude and Perplexity draw search.
    Section titles are the first row of their section, not pinned `header:`s, so they
    scroll away with their rows instead of sitting over them.
    Under the field is the web's filter row (`ThreeColumnSearchDialog`) as `OkouChip`s on
    the field's 16 pt edge: All, Chats, Messages, Workflows, Artifacts. Without a
    query, All and Chats show recent chats, Workflows lists everything, and
    Messages and Artifacts ask for a word (both are searched on the server). A chat or message
    opens its chat; a workflow opens a new chat with `/name` in the draft, as the composer's
    `/` menu does; an artifact opens in the app's own preview, or on the web's Artifacts page when the app
    cannot read its address.

### Status and feedback

Measured against ChatGPT, Claude, Manus, Gemini, Perplexity and Grok on iOS (November
2026): problems are quiet, degraded service is described as status, a confirmation is a
single floating line, and colour is a small accent for status only.

- **Empty, failed and unavailable screens** use `OkouEmptyState`: a 24 pt muted glyph on a
  52 pt `state-hover` circle, a 17 pt medium title, a 15 pt muted description at most 300 pt
  wide, and at most two compact outline actions (a failed load always offers Try again). It
  sets its own type and colours; never `ContentUnavailableView`, whose styles a parent's font
  and foreground override.
- **A failed read in a list, sheet or card** is `OkouLoadErrorRow` (web `LoadErrorRow`): one
  muted sentence where the content would be and a quiet text action. Red is only for actions
  the reader started (a send or upload that failed, an auth error, Sign-in expired, Limit
  reached) and for destructive verbs, never for a failed read.
- **Loading inside a list, sheet or card** is `OkouLoadingRow`: a small muted spinner and what
  is loading, in subheadline. Status is never a bare `ProgressView`. A sheet's first load
  is `ChatSettingsLoadingView`, the same spinner and line centred where the content will
  appear. A chat's first load is `OkouChatSkeleton`, the web's chat skeleton: two
  exchanges of a trailing user bubble and an answer under a small avatar in `skeleton`
  grey (`OkouSkeletonBlock`), shown after 100 ms as on the web — never a spinner in an
  empty page.
- **Skeletons shimmer as one.** Content with a known shape is drawn as its outline (a
  chat's exchanges) in `skeleton` grey shapes that do not move on their own; a picture
  whose content cannot be guessed (a cover, an image tile) is `OkouPictureLoading`: the
  `state-hover` ground, plus a faint glyph of its kind in a tile, never a made-up outline of
  a page. Either way the group carries one motion, `okouShimmer()`: a soft band of the
  page's ground, slanted 12°, crosses every block together every 1.6 s
  (`OkouMotion.shimmer`), lifting the grey a little without washing it out, as feeds and
  media apps draw loading. Under Reduce Motion nothing travels: the group breathes
  1 → 0.7 over two seconds, the web's `okou-skeleton-pulse`.
- **A status line in a screen's flow** (a draft that could not be saved,
  a stop that did not confirm, a voice or attachment error above the composer) is
  `OkouBanner`: a hairline card at chat radius, a 16 pt glyph, one footnote sentence, its
  actions as footnote-semibold text buttons and an optional ✕. `.status` is muted; `.problem`
  only lifts the text to `foreground`. It is never red and never a tinted fill. The composer
  shows these banners and nothing hand-built.
- **Chat feedback floats under the header** in `ChatFeedbackSurface`: a finished action
  ("Chat archived · Undo") or a sync failure with Retry, one at a time. Liquid Glass at
  card radius, a 16 pt muted Lucide glyph (a small spinner while retrying), one 15 pt
  medium line, an optional semibold `foreground` action (as `OkouBanner`'s) and a ✕; at
  accessibility sizes the action
  moves under the text. Routine synchronization is silent — no "Updating chats…" line —
  and a failure shows only after it has lasted 300 ms. Confirm in place first where
  possible (a copy glyph turning into a check).
- **Running** uses `OkouRunningIndicator`, the web's breathing dot: a `running`
  (sky-600) dot breathing between 0.64× / 34 % and 0.88× / 52 % with a ring that
  spreads to 1.56× once per 2.4 s cycle. All indicators share one clock. It is the
  transcript's "working" line.
- **Working text** uses `OkouShimmerText`: the text stays in `foreground` and a
  soft-edged band of `placeholder` grey sweeps left to right once per 1.5 s
  (`OkouMotion.shimmerText`; the web's thinking label takes 3.5 s). On a gradient twice the
  text's width the band fades in from 28 %, is grey across 40–60 % and fades out by 72 %, so
  part of the title lightens at a time with soft edges and never reads as a grey block. Only the
  gradient moves, never the glyphs. Under Reduce Motion the text breathes like a skeleton
  (1 → 0.7 → 1 over 2 s) instead.
- `OkouUsageMeter` is the one allowance row: name left, "80% remaining" right
  (15 pt monospaced digits, muted), a 6 pt capsule that fills with what is left, and
  the reset below in caption — "Resets in 2 hr 10 min" under a day, otherwise
  "Resets Thu 9:00 AM". Every provider reads "remaining", never "used" (Claude counts
  used, Codex counts left; the screen picks one). The fill is `foreground`, orange at
  25 % or less, red at 0 % with "Limit reached" as the value. Show only windows the
  API returns, shortest first; never draw an empty bar.
- Streamed run text is published at most every 120 ms; a sync failure surfaces after
  300 ms; "Copied" confirmations last 1.5 s.

### Content

Textual Markdown uses `OkouMarkdownStyle` for links, code surfaces, headings, quotes, rules, and tables through public style hooks. Fenced code is `OkouCodeBlockStyle` (web `.wmde-markdown pre`): a `state-hover` fill with a hairline and an 8 pt corner, a 32 pt header with only the language (caption medium, muted) and a copy glyph that turns into a check, 85 % Geist Mono at the web's 1.45 line height with 12 pt padding, scrolling sideways. Table header and zebra rows use the neutral `state-selected` / `state-hover` layers. Inline code follows the web chip (85 % Geist Mono, `gray-200`, 0.2 em × 0.4 em padding, 4 pt corner). Textual's inline style sets only font and colours, so `withInlineCodeChips()` turns a short span (at most 40 characters, not inside a link) into an `OkouInlineCodeChip` attachment: its placeholder reserves only the body line's ascent and the chip hangs into the descent, because SwiftUI adds a lowered placeholder's offset to the line height. Longer spans stay styled text so they can wrap, VoiceOver gets plain text (an attachment would read as an image), and a selection copies the code. Code syntax highlighting retains the renderer-owned language token palette; it is content coloring rather than a UI action/status palette.

- **Cards in the transcript** use `ChatCardSurface` (`OkouSurfaceStyle`, chat radius) and
  open with `ChatCardHeader`, as the web's `AssistantErrorCard`: a 16 pt glyph in
  `muted-foreground` on the title's first line (no tile behind it), the title in callout medium,
  every detail line in subheadline `muted-foreground`. Callers never restyle the details, so a
  card uses at most three sizes.
- **Card actions** use `ChatCardButtonStyle`: the web's small outline button (`gray-400`
  hairline on the background fill, 8 pt corner, the pressed state laid over the fill),
  `.primary` for the card's single committing action, `.detail` for a bare text action. A
  destructive role (Discard, Deny) keeps the outline and turns its label red; every commit
  that leaves the company asks for confirmation first.
- **Results in the transcript** keep the web's shapes in the app's card style. A
  picture or video is `OkouResultTile`, the web's Markdown image: one fixed 200 × 180 pt
  frame (`mediaTileWidth`, `cardMediaHeight`) with the whole picture fitted inside on the
  `state-hover` ground, nothing cropped, no caption. A website, slides or a document is
  `OkouResultCard`, the web's `SitePreviewCard`: the transcript card heading
  (`ChatCardHeader`: muted glyph, title, one detail line such as "Slides · PPTX ·
  2.3 MB" or "Website · lumina.okou.app") over one 16:9 cover for every kind (a site or a page fills it from the top; a deck's first slide sits in it whole, so a 4:3 slide is centred on the neutral ground), at most
  400 pt wide; any other file is the heading alone. Tiles and cards share the chat card
  corner and hairline. The shape comes from the result as the message writes it, never
  from what loads, so the row's height is fixed before the picture arrives. The cover is
  the server's preview image; without one a website is drawn once off screen at
  1280 × 720 (`SitePreviewSnapshotter`, which also gives the card the page's title, as the
  web's card shows the live page) and a PDF or deck under 25 MB draws its first page with
  Quick Look. A file the user attached uses the same tile and card. A link in the text to
  a hosted site, published page or chat file gets its card after the passage that names
  it, once per message; the text keeps the link.
- **Message actions** under the last answer of a turn are the web's: copy and share
  (`copy`, `share-2`), 16 pt glyphs in `gray-600` (the web's muted-foreground at 60 %), 32 pt
  apart (`messageActionPitch`), the first glyph on the answer's text edge. Copy turns into a
  check in place.
- **"Keep going" follow-ups** copy the web: a run-section label in the native serif
  italic (`Font.okou(_:design: .serif)`, the face the web's `ui-serif` resolves to)
  at 50 % `muted-foreground`, a 1 pt rule in `divider` at 40 %, and quick-reply cards
  in the neutral `state-hover` layer (`state-pressed` while pressed) with
  `muted-foreground` text at 80 %, card radius, at most two lines. The timestamp is
  the web's chat timestamp ("Sep 8, 6:33 PM").

### Identity

#### Agent artwork

`OkouAgentAvatar` is shared by chat rows, the new-chat greeting, and assistant
messages. The default agent uses the canonical Okou
avatar. Other agents show an uploaded bitmap image or a neutral tile with their
name's initial. Keep the existing typography, semantic colors, native sizing,
and accessible name in the shared component.

Native has no avatar editor and does not bundle or compose avatar layers.
Preset identifiers and SVG URLs use the initial tile. Keep persisted avatar
values with their owning service; this presentation policy does not rewrite
another client's avatar configuration. Unavailable custom images use the same
initial tile.

Composer chat and workflow suggestions use text-first `OkouSuggestionRow` content
inside `OkouSuggestionPanel`. Chat titles have no avatar or reserved artwork
column and may wrap to two lines. Workflow names retain a trailing slash command
and an optional description. Both pickers share the same editor-anchored overlay,
native table, dismissal, and semantic focus layer; the editor retains first
responder while the list scrolls or inserts a candidate. Empty queries have no
implicit selection. The table measures self-sizing content within the available
height rather than forcing the editor to move with the candidate count.

#### Workspace artwork

`OkouWorkspaceLogo` shows an uploaded organization logo only when Clerk's
`hasImage` is true; the SDK also supplies generated image URLs, which must not
be mistaken for custom uploads. Without a custom image, use the exact eight
Web texture/mark pairs selected by FNV-1a of the workspace ID over UTF-16.
Default artwork stays the same across themes and clients. Workspace marks are
rounded squares, with a radius of one quarter of their size; people remain a
separate avatar family. Use the shared logo in workspace chrome, selection,
and settings. The compact native workspace mark is 32 pt.

`sync-workspace-assets.py` derives the eight bundled vector compositions from
`core/src/workspace-logo.ts`, the published brand textures, and Web's own
four-petal mark. The 160% centered texture and 58% mark proportions follow Web.
`DesignSystem/Components/Identity/workspace-assets.json` records source and output hashes; `--check`
verifies them offline. Artwork fills are brand asset colors, not interface-role
substitutes. A missing upload falls back to that workspace's deterministic mark.

### Component index

Every shared view, in the same groups. Feature folders keep only views bound to a store.

#### Foundations

| Component                                                                  | Use / states                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouSurfaceStyle`                                                         | Noninteractive card shell; shared fill, border, native radius; add interaction only at the owning semantic control                                                         |
| `OkouIcon`, `OkouToolbarIcon`, `Label(okouSymbol:)`, `Button(okouSymbol:)` | Shared product icon assets; preserve native labels, menu behavior, and button roles                                                                                        |
| `OkouLineIcon`                                                             | A glyph centred on the first line of the text beside it in a `.firstTextBaseline` row (feedback, search results); a bare glyph there rides high because it has no baseline |
| `OkouGlassControl`                                                         | Clear glass icon (`.circle`) or labeled (`.capsule`) control on an exact 44 pt shape; pairs and bars read at one size                                                      |
| `OkouFloatingPanelStyle`                                                   | Card surface plus the floating shadow for suggestion panels over the transcript                                                                                            |
| `okouGroupedBackground()`                                                  | The one ground for grouped List/Form sheets                                                                                                                                |
| `okouSheetBackground()`                                                    | A sheet's opaque ground, set on the view the sheet presents (beside its detents), never inside its navigation stack                                                        |
| `OkouWordmark`                                                             | Approved aspect ratio and theme-aware foreground                                                                                                                           |
| `OkouAuthTheme`                                                            | Public Clerk integration; retains SDK-owned authentication behavior                                                                                                        |

#### Actions

| Component                                       | Use / states                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouButtonStyle`                               | Filled primary or the web outline button; `isCompact` for two actions side by side; a destructive role keeps the outline with a red label; default, pressed, disabled |
| `OkouCloseButton`                               | Native toolbar dismissal                                                                                                                                              |
| `OkouCloseToolbarItem`                          | The close button in its one place: the toolbar's trailing end                                                                                                         |
| `OkouProviderButtonStyle` / `OkouProviderLabel` | Full-width provider action: the provider's own mark (bundled, 20 pt slot) and an explicit provider name centred on one line; neutral resting/pressed/disabled states  |

#### Selection and input

| Component                                   | Use / states                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouTextFieldStyle`                        | First-party standalone native text fields; resting, focused, disabled; the caller supplies `isFocused` from the native field binding and owns labels/validation                                                        |
| `okouValuePicker()`                         | Menu picker whose trailing value and chevron are `trailingValue` (gray-700), a step lighter than the label                                                                                                             |
| `OkouComposerValueLabel`                    | A value the open composer changes (the chat's model): subheadline medium value, muted detail that gives way first, a chevron, on the 44 pt action height                                                               |
| `OkouChip` / `OkouChipRail`                 | Filter capsules in the web's colours, in a sideways-scrolling row starting on the content edge; selected takes `state-selected`                                                                                        |
| `OkouSegmentControl`                        | Large segmented shape in the web's segment colours: grey track, white raised selection                                                                                                                                 |
| `OkouAddIndicator`                          | A catalog card's trailing "+" (add now) or chevron (added; the card opens it), 32 pt in a 44 pt target                                                                                                                 |
| `OkouNameDialog`                            | Native name alert (new or renamed project, renamed chat): one field, Cancel and a preferred Save, off while the name is empty or too long                                                                              |
| `OkouComposerSurface`                       | The composer's glass surface: 44 pt compact with 44 pt actions either side; expanded keeps the editor and puts the actions on a bottom row                                                                             |
| `OkouSuggestionPanel` / `OkouSuggestionRow` | Composer chat and workflow suggestions above the editor: a floating panel with a footnote title and ✕, text-first rows (a chat title wraps to two lines; a workflow adds its trailing slash command and a description) |

#### Lists and rows

| Component                                  | Use / states                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouRowLabel`                             | Row title with its leading graphic in the shared 28 pt slot                                                                                               |
| `OkouValueRow`                             | A grouped row with a trailing value (system Settings style): the title keeps one line, the 17 pt `trailingValue` value yields and truncates in the middle |
| `okouSectionHeader()`, `okouSectionNote()` | Grouped-list section header (15 pt medium) and footer note (13 pt muted)                                                                                  |
| `OkouChatRowLabel` / `OkouChatStatusMark`  | A sidebar chat: status column (emoji or quiet glyph), one body line (medium when unread, shimmering while working), trailing unread / draft / pin         |
| `OkouListDivider`                          | A hairline in `border` between list sections (the projects and the chats below)                                                                           |
| `OkouActionRow`                            | A plain sheet's action row (Add to chat): row label in body, 48 pt, page edge, destructive red, optional trailing note                                    |
| `OkouAccountRowLabel`                      | The Settings account: 40 pt mark, name in body medium, email in footnote supporting text                                                                  |

#### Navigation and search

| Component         | Use / states                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouSearchBar`   | Shared 44 pt clear glass capsule with the Lucide `search` glyph in placeholder grey; wraps the sidebar's search prompt or the search page's native input                                                 |
| `OkouSearchPage`  | A large native sheet with a fixed search field, one-action trailing close, pinned filters on a solid header, transparent list rows and one empty state centred above the keyboard. Catalog: Search sheet |
| `OkouSearchField` | Native text editing focused once during presentation, with IME composition and selection preserved; keyboard Search ends editing without closing the page                                                |

#### Status and feedback

| Component                                | Use / states                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OkouRunningIndicator`                   | Web's breathing running dot, the transcript's working line                                                                                                                                                                                                         |
| `OkouShimmerText`                        | Working text: a soft-edged band of `placeholder` grey sweeping across `foreground` text every 1.5 s (`okouShimmerText()`)                                                                                                                                          |
| `OkouUnreadBadge`                        | An 8 pt `running` dot over a glyph's top-right corner, as an iOS badged symbol: a ring cut out of the glyph keeps a gap between them. It marks something unread inside (the menu button, a folded project's folder); the control's accessibility value says Unread |
| `OkouLoadErrorRow` / `OkouLoadingRow`    | A failed read (muted sentence + quiet Try again) and a loading line (small muted spinner + label) inside lists, sheets and cards                                                                                                                                   |
| `OkouChatSkeleton` / `OkouSkeletonBlock` | A chat's first load as the web draws it: placeholder exchanges in `skeleton` grey, shimmering as one (`okouShimmer()`)                                                                                                                                             |
| `OkouBanner`                             | In-flow status line: hairline card, glyph, footnote sentence, text actions, optional ✕; `.status` / `.problem`, never red                                                                                                                                          |
| `ChatFeedbackSurface`                    | Chat feedback under the header: glass, Lucide glyph or spinner, one 15 pt medium line, optional action, ✕                                                                                                                                                          |
| `OkouEmptyState`                         | Quiet empty, failed or unavailable screen: muted glyph on a soft circle, 17 pt medium title, 15 pt muted description, up to two outline actions; `verbatim:` for a content title                                                                                   |
| `OkouUsageMeter`                         | Allowance row: label, "% remaining", capacity bar (normal / low / exhausted), reset time                                                                                                                                                                           |
| `OkouLiveWaveform`                       | Dictation waveform: one bar per level sample, gliding every frame, newest growing in at the trailing edge, baseline dots before audio; static under Reduce Motion                                                                                                  |

#### Content

| Component                                                                     | Use / states                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChatCardHeader` / `ChatCardButtonStyle` (`.standard`, `.detail`, `.primary`) | Web card heading (16 pt muted glyph, callout medium title, one detail style) and card actions (outline, primary, text; destructive role in red)                                      |
| `OkouInlineCodeChip`                                                          | Web-style inline code in Markdown: padding and a 4 pt corner, on the sentence's baseline without growing the line; short spans only, off under VoiceOver                             |
| `OkouActionTile` / `OkouMediaThumbnail` / `OkouSelectionMark`                 | An 88 pt media-strip tile (Camera), a photo thumbnail with a hairline, and its pick mark (open ring, then amber with an ink check)                                                   |
| `OkouResultCard` / `OkouResultTile` / `OkouPreviewState`                      | A result in the transcript: card heading over a 16:9 cover (website, slides, document) or a fixed 200 × 180 tile with the whole picture; loading pulse, picture, or the kind's glyph |

#### Identity

| Component                              | Use / states                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouAgentAvatar`, `OkouWorkspaceLogo` | Shared avatar and workspace artwork with native sizing                                                                                                     |
| `OkouProfileAvatar`                    | The signed-in person's photo in a circle with a hairline; without one the web's initial on `muted` (sidebar Settings, Settings profile row)                |
| `OkouWorkspaceMenuLogos`               | Workspace logos for a system menu: each tile drawn once at 28 pt (`OkouAvatarSize.menu`) with the logo's own corners; a neutral tile until an upload loads |
| `OkouWorkspaceGlassLogo`               | A workspace's logo as a 44 pt glass circle (the sidebar's switcher): the logo round at 28 pt (`OkouAvatarSize.glassControl`), concentric with the circle   |
| `OkouLogoTile`                         | A partner logo or glyph on a quiet square tile (44 / 64 pt) so catalog marks line up                                                                       |

#### Feature and catalog

| Component             | Use / states                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NewChatGreeting`     | New-chat greeting with Web's word-by-word entrance                                                                                             |
| `ConnectorLogo`       | Partner catalog logo (PNG/SVG) in a 24 pt slot with a glyph fallback                                                                           |
| `ResultStylesGallery` | Debug page of every result style and state in a chat, with covers from the real pipeline; in the catalog, or on its own with `--result-styles` |
| Feature components    | Compose the foundations for domain-specific information; promote only reusable visual/interaction patterns into DesignSystem                   |

## Patterns

How the product assembles components on its screens. The code stays with the owning
feature; the catalog shows each one.

### Chat

- **Chat header** has no title: the menu glass circle on the left, the chat's "…" menu on
  the right, over a soft blur. The selected row in the sidebar says which chat
  is open. The "…" menu is titled with the chat and starts with Pin chat.
- **The model control is in the open composer**, left of the mic and send, as Claude and
  ChatGPT place it: `ChatModelPickerButton` draws an `OkouComposerValueLabel` with the
  model's name in subheadline medium `foreground`, its thinking effort and Fast in
  subheadline `muted-foreground` ("GPT 6.1 Sol High") and a chevron. It shows only while the
  composer is open, where the next message is written, and is gone from the one-line
  composer and while dictating. On the home screen it is the next new chat's model; in a
  chat, that chat's. The composer presents the model sheet, and keeps itself open under it,
  so the sheet survives the keyboard going down and the keyboard comes back after it. The
  composer's only leading control is `+`, which opens **Add to
  chat** (`ComposerAddSheet`, after Manus and Claude): a sideways strip of 88 pt tiles —
  `OkouActionTile` Camera, then the latest photos as `OkouMediaThumbnail`s once the reader
  lets Okou see the library — where photos are picked with `OkouSelectionMark` (an open
  white ring, then the web checkbox's amber fill with an ink check) and added with one
  "Add N" primary button; then rows: All photos (the system picker), Scan Document (where
  the device can scan), Choose Files, Connectors (with "Confirm settings" while they are
  uncertain) and Clear draft. A connector uncertainty badge stays on `+`; opening the
  sheet never enables service access. The camera, pickers and connectors open once the
  sheet has gone.
- **The model sheet** (`ChatModelPickerView`) follows ChatGPT's Configure sheet as a short
  form, the way Calendar's new event drills into Repeat and Alert:
  - the form: one card with Model (the drafted model's name, which opens the model list),
    then Thinking effort and Speed (Standard or Fast) as value menus, Fast's cost heading its
    menu since a menu shows one line per option; Set as default for new chats (a new chat
    only) as a medium-weight ink action in a card of its own; Done pinned at the bottom;
  - the model list is pushed, since several companies' models would crowd one menu: every
    model under its company's heading, with the subscriptions to connect or manage after
    them, opened scrolled to the checked model. Picking one checks it and returns to the
    form, with the effort last chosen for that model and the standard speed;
  - both pages keep the sheet's half height, so the list slides in where the form was; a
    drag, or scrolling the list, takes it to full height. Changing the height as a page
    pushes moved the page up the screen as it slid in;
  - the choices are a draft: nothing behind the sheet changes, and Done saves model, effort
    and speed in one write (`ChatModelSelectionStore.apply(_:)`), then closes with a
    selection haptic and the composer's model control shows the result. A failed save keeps
    the sheet and the draft, with the error above Done; ✕ or a swipe drops the draft.
- **Send / stop / mic** share the composer's trailing slot: the mic alone on an empty
  draft, mic then send (`.glassProminent`, `primary`) once there is content, and stop
  (`interrupt`) alone while a run is active and the draft is empty. In the open composer
  the model control comes first.
- **The composer never truncates a draft.** With text in it the editor keeps its
  open height (up to six lines, then it scrolls), focused or not.
- **Composer geometry** belongs to `OkouComposerSurface`, shared by the chat and
  component catalog. Its empty, unfocused surface is at least 44 pt tall
  (`composerCompactHeight`), with 6 pt vertical text padding and separate 44 pt
  action targets. Larger text can grow the surface. Expansion retains the same
  mounted editor and reserves a bottom row for the actions. Leading and trailing
  action targets keep the same horizontal anchors through expansion. The composer
  uses the 24 pt page inset; its resting actions share the sidebar footer's vertical
  center with 6 pt below the surface. Focused editing keeps 8 pt above the keyboard.
- **A tap outside the composer puts the keyboard away.** A tap anywhere on the transcript
  (`KeyboardDismissTap`, which never takes the tap from links, cards or selection) or on the
  new-chat page ends editing, so an empty composer folds back to one line.
- **Dictation** works the way ChatGPT's does. The mic dismisses the keyboard and the
  composer collapses to its one-line height, whatever it held, into `VoiceRecordingBar`:
  cancel (✕), `OkouLiveWaveform`, stop (■ — the words go into the draft to read and
  edit) and send (↑ — the words are sent as heard). There is no red dot or timer: it is
  typing by voice, not making a recording. The draft comes back unchanged on cancel.
  Levels are sampled every 50 ms on a decibel scale (−45 dBFS → 0, −8 dBFS → 1) with a
  short release; the waveform draws 3 pt bars with 2 pt gaps that glide one bar per
  sample, the newest growing in at the trailing edge and the oldest fading out at the
  leading one; slots with no audio yet are baseline dots.
- **New-chat greeting** (`NewChatGreeting`) is stacked and centred: Okou's avatar,
  then the tagline. Avatar and words enter like the web — opacity, 8 pt blur and 14 pt rise over 720 ms
  (cubic-bezier 0.22, 1, 0.36, 1), each word 70 ms after the previous, whole words
  wrapping onto centred lines. It replays for each return home, and
  rotates through the web's 16 taglines (7 without a name), translated from the
  web's locale files. Reduce Motion shows it at rest.

### Sidebar

- **The sidebar and the chat are two full pages**: chat titles are long, and the
  chat never shows beside the list. `WorkspaceNavigation` uses a native
  `UINavigationController`, with the sidebar at its root and the chat pushed above it.
  The navigation bar stays hidden: each page retains its custom header, footer,
  typography, colors and controls. UIKit owns push/pop animations, interactive
  return and Reduce Motion adaptation. Retain both page hosts across navigation
  so drafts and scroll state survive. Forward the SwiftUI environment to both
  hosts, including appearance, scene phase and scoped link/system-entry actions.
- **Sidebar layout**: the workspace switcher top left, and top right one 44 pt glass capsule
  that groups the chat list menu (Lucide `list-filter`) on the left and back to the chat
  (`arrow-right`, toward the page it returns to; "Close sidebar" for VoiceOver) on the right,
  as iOS groups related bar buttons. The menu is an icon on the default Chats and names any
  other filter ("Unread"), so a filtered list never reads as missing chats. A left swipe and
  VoiceOver's escape gesture return to the chat too. The switcher is the workspace's
  logo as a glass button (`OkouWorkspaceGlassLogo`: the logo round at 28 pt,
  `OkouAvatarSize.glassControl`, so it sits concentric in the circle), with the workspace
  name beside it and no arrow, as in Slack. The switcher opens the system menu with every workspace's
  logo beside its name and the system check on the current one, as the web's switcher
  lists them; a menu draws images, not views, so `OkouWorkspaceMenuLogos` draws each
  tile once (28 pt, `OkouAvatarSize.menu`) with the logo's own rounded corners. A thumb-reach bottom bar: the account's own photo
  (`OkouProfileAvatar`, 44 pt) opens Settings on the left, a search capsule fills the
  middle, and new chat is the prominent circle on the right.
- **Sidebar order**: the header's one menu holds the chat filter (the web's Inbox — All
  chats without archiving — / Unread / Archived / Muted), then Mark all read and New project,
  so the list starts 12 pt below the header. Projects come first, oldest first, as the web
  lists them; a whole project row folds it with `OkouMotion.disclosure`, a soft spring with
  no bounce, and its fold is remembered. The folder sits in the status column, so the name
  starts on the chat titles' edge, and the row ends with a 20 pt `chevron-down` in
  `quietMark` that turns right as the project folds. A folded project with an unread chat
  badges its folder (`OkouUnreadBadge`, as the menu button does), so the chevron keeps the
  trailing column in line with the chats' own dots.
  Inside an unfolded project, its pinned chats lead in their manual order, then
  the rest by latest activity, indented to the project's name; a project lists every chat it
  holds. An empty project says so in one quiet line, then offers "Show archived chats" when
  it holds archived ones. A hairline (`OkouListDivider`) closes the projects, and the chats
  outside them follow in the same order: pins first, then activity; with none, the inbox
  says so below the projects ("Your inbox is empty" and "Show archived chats" when it holds
  archived chats). Beside projects their status column always shows, so every title shares
  one edge. There are no section headings: a pin on the row marks a pinned chat. In the
  inbox, a pin moves up or down among the pins listed with it (Move up / Move down in the
  row's menu): a project's pins rank against each other across Agents, the others against
  their Agent's. Unread, Archived and Muted end with "Show all chats", which returns to the
  inbox.
  With a hardware keyboard, ⌘1–⌘9 open the first nine chats outside projects. Everything
  starts on the `pageInset` edge.
- **Swipes move between pages.** A right swipe anywhere in a chat opens the sidebar and a
  left swipe anywhere in the sidebar closes it, as does its back button; a swipe is never
  the only way back. Content that scrolls
  sideways (a code block or a table) keeps the finger, and from there the chat still opens
  the sidebar from its leading edge. UIKit owns the interactive pop; the list’s left
  swipe requests a native push rather than driving a custom transition.
  A page swipe never also taps the row under it. Chat rows keep their actions on the
  right swipe — Mark as read/unread, Archive — so they never compete with closing.

### Sign-in and account

- **Sign-in is one way in.** The first screen holds the providers and the email field
  together, as the web's sign-in does: Apple first (when Clerk offers it, through the
  system's own Sign in with Apple sheet), then Google, Microsoft and Slack with their marks
  bundled in the app (`AuthProvider-*`), "or", the email field and one Continue. The same
  Continue and the same provider buttons log an existing account in or create a new one
  (Clerk's transfer flow; an email Clerk does not know becomes a sign-up), so there is no
  separate "Create account" path. Back from the code or password step returns here with
  the email still filled in. There is no "More options": the first screen has every
  method Okou enables. Clerk's own screen, in its combined sign-in-or-up mode, opens only
  where the native steps stop — an extra verification the account requires ("Continue
  securely") and password help.
- **Signing out asks first.** Every Sign out (Settings, the workspace picker) goes through
  `signOutConfirmation`: the system confirmation dialog anchored to the button, "Sign out of
  Okou?", one line on what it costs, a destructive Sign out and Cancel — the same shape as
  the app's other destructive confirmations ("Disconnect account?").
- Account preferences live in the grouped Settings sheet: profile, workspace,
  notifications, appearance, language, support, version, then sign out.
  Destructive session actions stay apart from preferences. The account photo and
  the workspace mark are one size (`OkouAvatarSize.account`, 40 pt, the height of the
  account row's two lines), and the workspace card's rows share that slot so their text
  starts with the account name. The version is a row in Support, as in ChatGPT and
  Apple's Settings; no app logo at the foot (none of ChatGPT, Claude, Perplexity or
  Gemini shows one).

### Subscriptions and usage

- Allowance appears only on the Subscriptions page; the model sheet names providers
  without usage lines.
- One card per account, grouped by provider (the provider header only on its first
  card): email on one line truncated in the middle, a plan capsule and "Active", and
  an ellipsis menu with Use account / Reconnect / Disconnect (confirmed). A
  reconnect-needed account replaces its meters with one "Sign-in expired" row and a
  Reconnect action, explained in the footer. Unknown usage is one muted row; a reset
  date is shown only if it is in the future.
- "Add account" is the last section; pull to refresh replaces a refresh button.

### Connectors

- **Add connectors** is drawn in the web directory's colours on the same white page
  (the web's greys are made for white): a Discover / Custom segment control, the web's
  short category names as chips (the full name on the detail page), and one card per connector — logo tile, name,
  two lines of description, and "+" that connects at once while the rest of the card
  opens the detail. A connected card shows "Connected" in place of the description and
  a chevron in place of "+", as the web's card does. The detail is one card with the logo,
  name, description and compact Connect (or Add account) and Permissions buttons, then
  a facts card (status, category, how it signs in) and, only with several methods, a
  card that explains them. Custom holds "Create custom connector", the workspace's
  own connectors, and remote access (SSH, VNC).
- Connector rows show the partner's catalog logo through `ConnectorLogo` (24 pt
  slot; `pointSize` for a detail tile); the catalog serves PNG or SVG and `ConnectorIconLoader` rasterises SVG once
  with WebKit and caches it. The `plug`/`puzzle` glyph is only the loading and
  custom-connector fallback.

## Platform and SDK exceptions

- System menus, alerts, keyboard, selection handles, sheets, share/preview/media
  controllers, and native Form/List row chrome retain platform interaction and
  material behavior. Product labels and supplied menu icons use the shared
  typography/assets where the public API permits it.
- First-party authentication uses native provider, email, code, password, and
  required-profile steps, composed from shared controls. Provider availability,
  required fields, verification, transport, OAuth, and session authority come from
  the pinned Clerk SDK and server configuration. Do not infer completion from a
  submitted form or bypass additional factors. Native filled CTAs use
  `primary` / `primary-foreground`; provider rows use `card` / `control-border`.
  The full SDK flow remains available for additional account verification and
  recovery methods. Its public theme still shares link and filled-control primary
  colors; that SDK-owned surface uses ink for both through `OkouAuthTheme`, with the
  inverse on fills (white on ink, ink on near-white in dark). Native text actions on the
  sign-in steps (Change email, Resend code) are ink in medium weight. Do not modify
  dependency internals to style those exceptions.
- Web has no shared success/warning semantic pair for every native status case.
  `OkouStatusColor` centralizes native green/orange until those shared roles
  exist. Status text/icons must also identify the state; color alone is insufficient.
  `OkouStatusColor.running` is Tailwind `sky-600` (#0084D1), the palette stop Web's
  `RunningIndicator` uses; it moves to the generated roles once Web exports one.
- `OkouGroupedColor.background` is the system grouped background, owned by native
  List/Form rows; sheets reach it only through `okouGroupedBackground()`.
- System-owned dismiss/disclosure glyphs and third-party internals are outside
  the product Lucide replacement boundary.
- App Shortcuts use `AppShortcut.systemImageName`, which accepts only SF Symbols.
  This exception is limited to the system's shortcut presentation; in-app icons
  remain Lucide.

## The catalog

[`OkouDesignSystemCatalog.swift`](../../ios/Okou/DesignSystem/Catalog/OkouDesignSystemCatalog.swift)
is a live SwiftUI reference with light, dark, and large-text previews. Its index lists
the pages in this guide's order: Foundations (Color, Typography, Iconography, Materials &
surfaces), Components (one page per group) and Patterns (Chat, Sidebar, Sign-in &
account, Connectors). Each page shows its components' states with sample content; the
Iconography page holds the complete registered icon set. In a Debug
scheme, the `--mobile-design-system` launch argument opens this catalog without
initializing authentication or product services. In a Debug build it is also
in the app: **Settings ▸ Developer ▸ Design system** (and **Results in a chat**) pushes it
inside Settings, so Back returns to Settings and ✕ closes Settings from every catalog
page (`OkouDesignSystemCatalog(close:)`). Release builds do not
expose any of it.
Add `--composer-preview` alongside `--mobile-design-system` to open the catalog
on its Chat page, at the composer.
`--result-styles` opens only the results page (`ResultStylesGallery`): every way a
result looks in a chat, each state under a caption, with a live website snapshot and
Quick Look covers of a generated deck and document.

Reusable views live in `ios/Okou/DesignSystem` even when their names carry `Chat`
(`ChatCardSurface`, `ChatCardHeader`, `ChatActionCard`, `ChatCardButtonStyle`,
`ChatFeedbackSurface`); feature folders keep only views bound to a store, such as
`ChatFeedbackBanner`.

The Status & feedback page links to **Chat sync feedback** (`ChatSyncStatusGallery`),
which previews the production retry surfaces for realtime and chat-read failures. In
Debug builds, `--chat-sync-status` opens this page directly without initializing
authentication or product services.

The Iconography page's **Native icon calibration** includes native SF Symbol and
Okou glass actions, list labels, and a real UIKit menu containing both image
families. SF Symbols are restricted to these Debug comparison specimens; product
icons remain Lucide. Recheck this side-by-side reference when changing dimensions,
optical weight, asset generation, or supported OS versions. Inspect product menus,
composer/header controls, settings/connectors, content actions, and inline labels
as consumers of the same rules. Visual checks are on demand, not pixel assertions
in admission CI.

## Updating the system

1. Look for an existing role, asset, or component before introducing another.
2. For shared color changes, update the Web authority and regenerate native
   colors. For native dimensions or composition, update the Mobile foundation or
   owning component, then its consumers and catalog.
3. Put a new component in the `Components/` group for what it does, show its states on
   that group's catalog page, and add its row to the component index here. A new group
   needs its folder, its catalog page and its section here together.
4. Register new Lucide names in `DesignSystem/Foundations/icons.json`; regenerate rather
   than drawing substitute paths. Keep its version aligned with both Web
   dependencies. The script verifies the official archive's SHA-512 integrity
   and preserves the ISC/MIT license. The manifest owns the native 2-unit stroke;
   it deliberately differs from Web’s 1.5-unit optical weight.
5. Document any necessary platform exception here with its owner and reason.
   A one-screen visual preference does not justify a new global token.
6. Verify resource loading and relevant behavior, then explicitly inspect native
   rendering, keyboard behavior, large text, light/dark, and the supported OS
   boundary. Follow [native testing rules](ios-testing.md); ordinary visual
   acceptance is not a new screenshot admission test suite.

```sh
python3 ios/scripts/sync-design-tokens.py
python3 ios/scripts/sync-design-assets.py
python3 ios/scripts/sync-design-tokens.py --check
python3 ios/scripts/sync-design-assets.py --check
python3 ios/scripts/sync-workspace-assets.py --check
xcrun swift-format lint --strict --recursive ios/Okou ios/OkouTests ios/Push
```

After native acceptance, restore the preview simulator to the standard text size and appearance before handing it back. Large-text inspection must be identified as an accessibility test, not presented as the default component scale.

The asset script accepts `--archive /path/to/lucide-static-VERSION.tgz` for a
cached official archive; integrity validation still applies. Never edit generated
Swift colors, icon maps, vector paths, or generated color assets manually.
