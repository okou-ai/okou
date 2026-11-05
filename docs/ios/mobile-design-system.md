# Okou Mobile Design System

This is the design authority for first-party iOS UI. Its executable foundations
and reusable primitives live in [`ios/Okou/DesignSystem`](../../ios/Okou/DesignSystem).
New screens and design revisions start here. Web owns shared brand/color
definitions; Mobile owns native geometry, component composition, and interaction
adaptation. A component uses semantic roles rather than choosing palette stops
independently in each screen.

## Sources and ownership

| Layer                                    | Authority                                                                                      | Native consumer                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Shared colors, light/dark, state layers  | [`globals.css`](../../turbo/packages/ui/src/styles/globals.css), exported `--color-*` bindings | `OkouColor.generated.swift`                                    |
| App font family and sidebar-border alias | [`index.css`](../../turbo/apps/platform/src/views/css/index.css)                               | Geist / Geist Mono; generated sidebar-border                   |
| Native geometry and motion               | `OkouMetrics.swift`                                                                            | `OkouSpace`, `OkouRadius`, `OkouControl`, `OkouMotion`         |
| Typography and scaling                   | `OkouTypography.swift`; licensed fonts in `Resources/Fonts`                                    | `Font.okou`, UIKit font adapter                                |
| Product icons                            | Web's pinned `lucide-react`; matching official `lucide-static` vectors                         | `icons.json`, generated assets, `OkouIcon`                     |
| Product brand assets                     | Existing `OkouMark`, wordmark, and assistant avatar asset sets                                 | `OkouBrand`, `OkouWordmark`                                    |
| Common components                        | Files in `DesignSystem/`                                                                       | Buttons, fields, surfaces, empty states, auth theme            |
| Feature composition                      | The owning feature                                                                             | Chat cards, composer, sidebar, attachment and permission views |

Brand artwork retains its approved shape, aspect ratio, and colors. Do not
redraw logos with generic icons. Preserve multicolor partner/connector identities
and their own licenses; the Lucide template pipeline is for product interface
icons, not replacement partner logos. Add new assets to the owning catalog and
reference their semantic name through the shared layer.

## Color roles and Web parity

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
| Brand links and textual emphasis            | `brand-text`                                                 | Theme-aware readable brand text; not the raw Amber fill                                                     |
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

### Native and SDK exceptions

Textual Markdown uses `OkouMarkdownStyle` for links, code surfaces, headings, quotes, rules, and tables through public style hooks. Fenced code is `OkouCodeBlockStyle` (web `.wmde-markdown pre`): a `state-hover` fill with a hairline and an 8 pt corner, a 32 pt header with only the language (caption medium, muted) and a copy glyph that turns into a check, 85 % Geist Mono at the web's 1.45 line height with 12 pt padding, scrolling sideways. Table header and zebra rows use the neutral `state-selected` / `state-hover` layers. Inline code follows the web chip (85 % Geist Mono, `gray-200`, 0.2 em × 0.4 em padding, 4 pt corner). Textual's inline style sets only font and colours, so `withInlineCodeChips()` turns a short span (at most 40 characters, not inside a link) into an `OkouInlineCodeChip` attachment: its placeholder reserves only the body line's ascent and the chip hangs into the descent, because SwiftUI adds a lowered placeholder's offset to the line height. Longer spans stay styled text so they can wrap, VoiceOver gets plain text (an attachment would read as an image), and a selection copies the code. Code syntax highlighting retains the renderer-owned language token palette; it is content coloring rather than a UI action/status palette.

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
  colors; that SDK-owned surface uses the readable provider pair through
  `OkouAuthTheme`. Do not modify dependency internals to style those exceptions.
- Web has no shared success/warning semantic pair for every native status case.
  `OkouStatusColor` centralizes native green/orange until those shared roles
  exist. Status text/icons must also identify the state; color alone is insufficient.
  `OkouStatusColor.running` is Tailwind `sky-600` (#0084D1), the palette stop Web's
  `RunningIndicator` uses; it moves to the generated roles once Web exports one.
- `OkouGroupedColor.background` is the system grouped background, owned by native
  List/Form rows; sheets reach it only through `okouGroupedBackground()`.
- System-owned dismiss/disclosure glyphs and third-party internals are outside
  the product Lucide replacement boundary.

## Native foundations

All geometry is measured in points. Values are Mobile design choices; they are
not copied from CSS and are not all mandated by Apple.

| Foundation   | Rule                                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typeface     | Geist for UI, Geist Mono for code; system fallback covers unsupported scripts                                                                                                                                                                                                                                  |
| Type scale   | Large title 34, title 28, title2 22, title3 20, body/headline 17, callout 16, subheadline 15, footnote 13, caption 12, caption2 11                                                                                                                                                                             |
| Text scaling | Use `Font.okou(.body)` and corresponding named styles. A fixed `size:` is only for already scaled measurements or constrained artwork; ordinary body text uses Dynamic Type                                                                                                                                    |
| Spacing      | Prefer 4, 8, 12, 16, 20, 24, 32, 40, 48 via `OkouSpace`; smaller named steps serve tight component internals                                                                                                                                                                                                   |
| Radius       | Inline code 4, thumbnail 6, small 8, control 14, chat 16, card 20, sheet 28; circles/capsules remain native shapes                                                                                                                                                                                             |
| Type roles   | One surface uses at most three sizes: body 17 for content and input, callout 16 for controls inside the composer, footnote/caption for supporting text. Never shrink a control label below callout to make it fit                                                                                              |
| Controls     | Minimum interactive area 44 (`minimumTarget`); large form control 52; list row 48 / agent row 50; inline content action 36 tall × 44 wide; status column 22; filter chip 36; catalog logo tile 44 / 64 with a 32 pt add control; dictation waveform 28 tall (3 pt bars, 2 pt gaps); labels can grow vertically |
| Layout       | Page inset 24 (`pageInset`) is the one leading edge for a screen's header, section headings, rows and footer; readable single-column width 440; respect safe areas and keyboard avoidance                                                                                                                      |
| Icons        | Canonical Lucide 24-unit paths; native 2-unit stroke. Compiled image intrinsic size is 20 pt for system menu hosts. Explicit SwiftUI geometry follows the role table below.                                                                                                                                    |
| Motion       | Press feedback 150 ms, ordinary transition 250 ms; honor Reduce Motion; product-specific motion is ported from Web with its timing as `OkouMotion` tokens (greeting words, running cycle, 50 ms waveform sample, 25 % sidebar parallax)                                                                        |
| Elevation    | No shadows on in-flow content. Only surfaces floating over content (suggestion panels) take `OkouElevation.floating*` (8 % black, radius 16, y 6)                                                                                                                                                              |
| Haptics      | `sensoryFeedback` only for committed moments: send (light impact), stop (medium), success of a copy/approval/send, error, sidebar open/close (selection). Never on scroll or typing                                                                                                                            |

An icon inside a `Label` is decorative: its text names the action. Icon-only
buttons require an explicit accessible label. Errors appear next to the owning
input/action and retain an accessible explanation. Keep keyboard type, content
type, autofill, IME composition, focus restoration, and native dismissal behavior
with their owning input/controller.

## Brand expression and product navigation

Okou is warm, clear, and capable. Preserve the Web's Amber/Ink action pair,
Geist typography, Lucide artwork with native optical weight, wordmark, and illustrated agent family.
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
  separate color role. Never tint ordinary navigation icons with `brand-text`.
- Native UIKit menus consume the image's intrinsic dimensions. SwiftUI frame
  modifiers and SF Symbol configurations do not resize a custom UIImage there.
  The asset generator therefore emits `width="20" height="20"` while preserving
  `viewBox="0 0 24 24"` and the canonical vector paths. Do not pass uncalibrated
  raw 24 pt assets into `UIAction` or repair each menu with a different thumbnail.
  The manifest owns any per-glyph optical correction: the outline `pencil` uses
  0.8 scale around the viewBox center to match native pencil footprint. Its source
  paths remain unchanged. Do not scatter scaleEffect adjustments across features.
- Use named roles throughout features. Keep larger card/media placeholders and
  small inline accessories intentional; they are not exceptions to fix by a
  global scale multiplier. Caption labels explicitly request an inline icon.
  Chevrons and diagonal external-link arrows use a 16 pt canvas because their
  paths occupy about half the viewBox; a 12 pt canvas makes the drawn hint tiny.
  Stop uses a 16 pt square, matching the smaller footprint of a native stop glyph,
  while send retains the calibrated toolbar arrow.

### Controls

- **Glass controls** use `OkouGlassControl`: native `.glassEffect(.regular.interactive())`
  drawn on an exact 44 pt shape — `.circle` for a single glyph (menu, back to chat),
  `.capsule` at the same 44 pt height for a labeled control (the sidebar's search
  field). `isProminent` is a bar's one primary action (the sidebar's new chat): the
  same shape tinted `foreground` with a `background` glyph. `.buttonStyle(.glass)`
  drew a ~35 pt circle inside its 44 pt frame and looked smaller than the UIKit glass
  "…" menu beside it. UIKit menu entries keep `UIButton.Configuration.glass()`.
  Paired controls in one bar are the same size.
- **Send / stop / mic** share the composer's trailing slot: the mic alone on an empty
  draft, mic then send (`.glassProminent`, `primary`) once there is content, and stop
  (`interrupt`) alone while a run is active and the draft is empty.
- **Dictation** works the way ChatGPT's does. The mic dismisses the keyboard and the
  composer collapses to its one-line height, whatever it held, into `VoiceRecordingBar`:
  cancel (✕), `OkouLiveWaveform`, stop (■ — the words go into the draft to read and
  edit) and send (↑ — the words are sent as heard). There is no red dot or timer: it is
  typing by voice, not making a recording. The draft comes back unchanged on cancel.
  Levels are sampled every 50 ms on a decibel scale (−45 dBFS → 0, −8 dBFS → 1) with a
  short release; the waveform draws 3 pt bars with 2 pt gaps that glide one bar per
  sample, the newest growing in at the trailing edge and the oldest fading out at the
  leading one; slots with no audio yet are baseline dots.
- **Catalog controls** (`OkouCatalogControls.swift`): `OkouChip` in an `OkouChipRail`
  for filters that scroll sideways (36 pt capsules; selected filled `foreground`, the
  rest cards with a hairline); `OkouLogoTile` (44 pt on a card, 64 pt on a detail page,
  `state-hover` fill and a hairline, corner 27 % of its size) so logos of any shape
  line up; `OkouAddIndicator`, the card's trailing 32 pt "+" that adds without opening
  the item and becomes a filled check once added. `okouSegmented()` is the large
  segmented control for a page-level switch (Discover / Custom).
- **Buttons**: `OkouButtonStyle(isPrimary:)` is a filled primary or the web's outline
  button. `isCompact` (15 pt, 44 pt tall, one line) fits two actions side by side on a
  card; the default size is for one full-width action.
- **The model control is in the header**, beside the menu, as Kimi and ChatGPT place it:
  `ChatModelPickerButton`, a 44 pt glass capsule with the model's name in callout medium
  `foreground` and its thinking effort and Fast in callout `muted-foreground` ("GPT 6.1 Sol
  High"). On the home screen it is the next new chat's model; in a chat, that chat's. It
  opens the model sheet. The composer's only leading control is `+`, whose menu holds Take
  Photo, Scan Document (only where the device has a camera), Photo Library, Choose Files and
  Connectors. A connector uncertainty badge stays on `+`; opening the menu never enables
  service access.
- **Card actions** use `ChatCardButtonStyle`: the web's small outline button (`gray-400`
  hairline on the background fill, 8 pt corner, the pressed state laid over the fill),
  `.primary` for the card's single committing action, `.detail` for a bare text action. A
  destructive role (Discard, Deny) keeps the outline and turns its label red; every commit
  that leaves the company asks for confirmation first.
- **Message actions** under the last answer of a turn are the web's: copy and share
  (`copy`, `share-2`), 16 pt glyphs in `gray-600` (the web's muted-foreground at 60 %), 32 pt
  apart (`messageActionPitch`), the first glyph on the answer's text edge. Copy turns into a
  check in place. Opening the chat on the web is in the header's "…" menu, not in this row.
- **Compact buttons** carry `OkouCompactButtonLabel` (16 pt glyph, 6 pt gap) so two
  side-by-side actions keep their whole titles. A full-size `OkouButtonStyle` is for a page's
  one main action (sign-in); inside sheets and cards actions are compact.
- **Value pickers** (Thinking effort, Appearance, Allow for, Category, Method) use
  `okouValuePicker()`: menu style with the value and chevron in `muted-foreground`.
  The app's global `foreground` tint otherwise drew the value as heavy as its label.
- **Action rows in lists** ("Use for new chats too", "Open Okou on web", "Connect …")
  are `foreground` text with a leading icon. Amber is for a filled primary commit
  (send, a card's `.primary` action), never for list text.
- **The composer never truncates a draft.** With text in it the editor keeps its
  open height (up to six lines, then it scrolls), focused or not.
- Viewing sheets and immediately applied settings use `OkouCloseButton`. Use Done
  for a completed operation, Save for an explicit commit, and Back within a sheet.
  Do not imply a pending save where selections already apply immediately.

### Surfaces

- **Page** canvas is `background`; the **sidebar** is `sidebar`.
- **Grouped sheets** (Settings, models, connectors, search, agent, subscriptions,
  usage) all use `okouGroupedBackground()`, which owns everything a grouped sheet
  shares, so no sheet can drift:
  - the system grouped background with the system's white rows (the product grey ramp
    is warm and read as pink behind white rows);
  - an opaque `presentationBackground`: at a partial detent an iOS 26 sheet is glass
    and the system turns grouped rows grey, while full height they are white;
  - the soft blur under the title bar (sheets do not inherit the root's style);
  - an 8 pt top content margin, so the first card starts just under the title bar.
- **Section headers** use `okouSectionHeader()`: 15 pt medium `foreground`, sentence
  case; a provider header adds its logo before the same text. Never the inherited
  17 pt body.
- **Section footers** use `okouSectionNote()`: 13 pt `muted-foreground`. A control's
  explanation (Fast mode cost, effort, scope of a switch) goes in the footer under its
  card, never as a row inside it — the system Settings pattern. One footer per card.
- **One text edge and one row height for the whole app.** Grouped rows never set
  their own height; `okouGroupedBackground()` sets the minimum (48 pt) and the
  system adds its padding. A row with a leading graphic (icon, partner logo, avatar,
  workspace mark) uses `OkouRowLabel`, which centres the graphic in the 28 pt
  `rowLeadingSlot`, so text starts on the same edge in every row and sheet. A sheet
  either gives every row a leading graphic (Settings, Connectors) or none (models,
  subscriptions); provider logos then live in the section headers.
- **One separator style per card.** Rows with a leading icon and rows without one
  inset their separators differently; do not mix them in one card. Options of a
  selection (Thinking effort, Fast mode) get their own card directly under the list
  they configure, with `.listSectionSpacing(.compact)`.
- **Cards in the transcript** use `ChatCardSurface` (`OkouSurfaceStyle`, chat radius) and
  open with `ChatCardHeader`, as the web's `AssistantErrorCard`: a 16 pt glyph in
  `brand-text` on the title's first line (no tile behind it), the title in callout medium,
  every detail line in subheadline `muted-foreground`. Callers never restyle the details, so a
  card uses at most three sizes. A file the user attached and a result the agent made use the
  same card: media preview 180 pt (`cardMediaHeight`), heading, trailing chevron.
- **Fills on white are neutral.** The warm `muted` and `control-surface` read pink on `card`
  and `background`; tiles, placeholders, media backdrops, zebra rows and tracks use the
  `state-hover` or `nested-fill` layers instead.
- **Floating panels** over the transcript (slash workflows, @mentions) use
  `OkouFloatingPanelStyle`: the same card, card radius, plus the floating shadow.
  Not `.regularMaterial` — a grey material block did not match the rest of the UI.
- **Edges under bars**: scroll edges default to native `.soft` (`OkouAppearance`).
  Where a custom bar's text sits over scrolling text the edge must hide it:
  - The chat transcript is `.soft` at both edges: its header holds only glass controls
    and no title. Its UIKit collection view gets the header and composer heights as
    `additionalSafeAreaInsets`, not `contentInset`, so the edge effects cover both bars.
  - The warm sidebar hides the system top edge and paints its header in `sidebar`
    with a 16 pt fade; the system hard band is white and read as a separate block.
    Verify both themes with text scrolled under each bar after changing either.
- Do not replace native Glass, Blur or safe-area bars with opaque cards, arbitrary
  opacity fills or custom outlines. Follow Reduce Transparency and Reduce Motion.

### Feedback and states

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
  is loading, in subheadline. Status is never a bare `ProgressView`.
- **A status line in a screen's flow** (sync slow or failed, a draft that could not be saved,
  a stop that did not confirm, a voice or attachment error above the composer) is
  `OkouBanner`: a hairline card at chat radius, a 16 pt glyph, one footnote sentence, its
  actions as footnote-semibold text buttons and an optional ✕. `.status` is muted; `.problem`
  only lifts the text to `foreground`. It is never red and never a tinted fill. The composer
  shows these banners and nothing hand-built.
- **A transient confirmation** ("Chat archived · Undo") is `OkouToast`: Liquid Glass the
  height of a control, one 15 pt medium line, an optional `brand-text` action and a small ✕,
  above the composer. It carries no icon. Confirm in place first where possible (a copy
  glyph turning into a check).

### Navigation and lists

- **The sidebar is full screen**, as in Grok, because chat titles are long. Opening it,
  the chat slides out to the right and blurs (`OkouElevation.sidebarBlur`, 12 pt) while
  the list slides in from 25 % to the left (`OkouMotion.sidebarParallax`) and comes
  into focus from the same blur. No shadow: the chat is off screen at full open.
- **Sidebar layout**: the workspace switcher top left and "back to chat" (»,
  `chevrons-right`) top right. A thumb-reach bottom bar: the account's own photo
  (`OkouProfileAvatar`, 44 pt) opens Settings on the left, a search capsule fills the
  middle, and new chat is the prominent circle on the right.
- **Pinned agents** are one sideways rail of `OkouAgentTile`s, proportioned on Instagram's
  story tray (measured 2026-11 from its App Store frames: ~79 pt photo in a 91 pt ring,
  ~11.5 pt name in one line, about ten characters then "…", ~4.5 visible): a 76 pt tile with
  a 56 pt avatar over its name in one 11 pt (caption2) line that ends in "…" when long, the
  selected agent on a `state-selected` tile, a blue dot for unread chats. Names never take two
  lines: the rail scrolls, so a long name further along would make every tile taller. The
  first avatar sits on the list's text edge.
- **Placeholders** (the composer's "Message Okou", the sidebar's "Search chats" and its glyph)
  use `OkouColor.placeholder` (gray-600), lighter than supporting text.
- **Sidebar order**: **Active** (running and unread chats from every agent, at most six,
  each with its agent's name as a caption line); the Pinned Agents rail; the chat filter (the
  web's Inbox — All chats without archiving — / Unread / Archived / Muted, then Mark
  all read); the selected agent's chats grouped Pinned / Today / Yesterday / Previous
  7 days / Earlier. Everything starts on the `pageInset` edge.
- **Rows** share one layout: optional status column, title (body, one line), trailing
  state. The status column holds the web's title status emoji (✅ Done, ⏳ Waiting, …);
  it appears in a section only when one of that section's chats has a status, and
  rows without one show a quiet `message-circle` glyph so titles stay on one edge.
  The emoji stays in the title so web and iOS agree; archive is a separate flag.
- **Trailing state** is the running indicator, an unread dot (8 pt `running` sky blue, as on
  the web; amber is kept for a primary commit), or nothing. Status is
  never a system spinner.
- **Chat header** has no title: the menu glass circle and the model capsule on the left, the
  chat's "…" menu on the right, over a soft blur. The selected row in the sidebar says which chat
  is open. The "…" menu is titled with the chat and starts with the agent (its name,
  "Agent profile"); on the new-chat screen the greeting's avatar opens the profile.
- Provider headings separate identity from allowance (`OkouLabeledValue`); do not
  shrink or truncate allowance text to fit beside a brand name.

### Status and motion

- **Running** uses `OkouRunningIndicator`, the web's breathing dot: a `running`
  (sky-600) dot breathing between 0.64× / 34 % and 0.88× / 52 % with a ring that
  spreads to 1.56× once per 2.4 s cycle. All indicators share one clock; list rows
  trail by `rowIndex / 12` so several running chats move as a wave. It is used in
  the sidebar and in the transcript's "working" line.
- **New-chat greeting** (`NewChatGreeting`) is stacked and centred: agent avatar,
  then the tagline, then a custom agent's description (the default agent shows nothing more). Avatar and
  words enter like the web — opacity, 8 pt blur and 14 pt rise over 720 ms
  (cubic-bezier 0.22, 1, 0.36, 1), each word 70 ms after the previous, whole words
  wrapping onto centred lines. It replays for each agent and each return home, and
  rotates through the web's 16 taglines (7 without a name), translated from the
  web's locale files. Reduce Motion shows it at rest.
- **"Keep going" follow-ups** copy the web: a run-section label in the native serif
  italic (`Font.okou(_:design: .serif)`, the face the web's `ui-serif` resolves to)
  at 50 % `muted-foreground`, a 1 pt rule in `divider` at 40 %, and quick-reply cards
  in the neutral `state-hover` layer (`state-pressed` while pressed) with
  `muted-foreground` text at 80 %, card radius, at most two lines. The timestamp is
  the web's chat timestamp ("Sep 8, 6:33 PM").
- Streamed run text is published at most every 120 ms; the sync banner waits 2.5 s
  before it appears; "Copied" confirmations last 1.5 s.

### Agent profile

The agent sheet is a profile card: a 64 pt avatar (`OkouAvatarSize.profile`), the name at
22 pt semibold (not repeated in the navigation bar), who can use it as a quiet capsule
(`users` / `lock`, nested fill), its description in 15 pt muted text, then two compact
actions side by side, New chat (primary) and Edit on web (outline). Workflows follow as
grouped rows with the shared 28 pt glyph slot, a 17 pt name and two 15 pt muted lines.

### Usage and subscriptions

- Allowance appears only on the Subscriptions page; the model sheet names providers
  without usage lines.
- `OkouUsageMeter` is the one allowance row: name left, "80% remaining" right
  (15 pt monospaced digits, muted), a 6 pt capsule that fills with what is left, and
  the reset below in caption — "Resets in 2 hr 10 min" under a day, otherwise
  "Resets Thu 9:00 AM". Every provider reads "remaining", never "used" (Claude counts
  used, Codex counts left; the screen picks one). The fill is `foreground`, orange at
  25 % or less, red at 0 % with "Limit reached" as the value. Show only windows the
  API returns, shortest first; never draw an empty bar.
- One card per account, grouped by provider (the provider header only on its first
  card): email on one line truncated in the middle, a plan capsule and "Active", and
  an ellipsis menu with Use account / Reconnect / Disconnect (confirmed). A
  reconnect-needed account replaces its meters with one "Sign-in expired" row and a
  Reconnect action, explained in the footer. Unknown usage is one muted row; a reset
  date is shown only if it is in the future.
- "Add account" is the last section; pull to refresh replaces a refresh button.

### Other surfaces

- **Add connectors** follows Manus: a large segmented Discover / Custom, the web's short
  category names as chips (the full name on the detail page), and one card per
  connector — logo tile, name, two lines of description, and "+" that connects at once
  while the rest of the card opens the detail. The detail is one card with the logo,
  name, description and compact Connect (or Add account) and Permissions buttons, then
  a facts card (status, category, how it signs in) and, only with several methods, a
  card that explains them. Custom holds "Create custom connector", the workspace's
  own connectors, and remote access (SSH, VNC).
- Connector rows show the partner's catalog logo through `ConnectorLogo` (24 pt
  slot; `pointSize` for a detail tile); the catalog serves PNG or SVG and `ConnectorIconLoader` rasterises SVG once
  with WebKit and caches it. The `plug`/`puzzle` glyph is only the loading and
  custom-connector fallback.
- Account preferences live in the grouped Settings sheet: profile, workspace,
  notifications, appearance, language, support, version, then sign out and delete
  account. Destructive session actions stay apart from preferences.
- App Shortcuts (`OkouIntents.swift`) accept only SF Symbol names; that system
  surface is the one product exception to Lucide-only icons.

### Agent artwork

`OkouAgentAvatar` renders the agent's persisted identity everywhere: pinned rows,
new-chat greeting, assistant messages, and mention suggestions. The default agent
uses the canonical Okou avatar. Other agents use their chosen image or composition;
an absent/unavailable custom image uses that agent's initial, never Okou's identity.
Message/sidebar/greeting sizes are 28/32/56 pt via `OkouAvatarSize`.

Web persists three image families: `preset:N`, legacy `svg:...`, and versioned
composer URLs whose query selects face, hair, expression, skin, hair color, and
sweater. Native composes the same bundled vectors, including Web's chin baseline,
framing, compatible combinations, and inherited sweater rule for older records.
Custom uploaded bitmap images load separately. The Web owner remains
`turbo/packages/core/src/agent-avatar.ts` and
`turbo/apps/platform/src/views/okou-page/avatar-svg-utils.ts`.

Run `python3 ios/scripts/sync-agent-avatars.py` when that library changes. It pins
the Web version and bundles its CDN layer files with SHA-256 provenance in
`DesignSystem/agent-avatars.json`; `--check` verifies local configuration and
asset integrity offline. Review framing changes against the Web owner too;
configuration synchronization does not automatically translate layout formulas.
No credentials or authenticated Web session are needed to render bundled avatars.

### Workspace artwork

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
`DesignSystem/workspace-assets.json` records source and output hashes; `--check`
verifies them offline. Artwork fills are brand asset colors, not interface-role
substitutes. A missing upload falls back to that workspace's deterministic mark.

## Components and composition

| Component                                                                     | Use / states                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OkouButtonStyle`                                                             | Filled primary or the web outline button; `isCompact` for two actions side by side; a destructive role keeps the outline with a red label; default, pressed, disabled            |
| `OkouTextFieldStyle`                                                          | First-party standalone native text fields; resting, focused, disabled; the caller supplies `isFocused` from the native field binding and owns labels/validation                  |
| `OkouSurfaceStyle`                                                            | Noninteractive card shell; shared fill, border, native radius; add interaction only at the owning semantic control                                                               |
| `OkouIcon`, `OkouToolbarIcon`, `Label(okouSymbol:)`, `Button(okouSymbol:)`    | Shared product icon assets; preserve native labels, menu behavior, and button roles                                                                                              |
| `OkouEmptyState`                                                              | Quiet empty, failed or unavailable screen: muted glyph on a soft circle, 17 pt medium title, 15 pt muted description, up to two outline actions; `verbatim:` for a content title |
| `OkouLoadErrorRow` / `OkouLoadingRow`                                         | A failed read (muted sentence + quiet Try again) and a loading line (small muted spinner + label) inside lists, sheets and cards                                                 |
| `OkouBanner`                                                                  | In-flow status line: hairline card, glyph, footnote sentence, text actions, optional ✕; `.status` / `.problem`, never red                                                        |
| `OkouToast`                                                                   | Floating confirmation: glass, one 15 pt medium line, optional action, ✕                                                                                                          |
| `OkouAgentAvatar`, `OkouWorkspaceLogo`                                        | Shared identity artwork with Web-compatible resolution and native sizing                                                                                                         |
| `OkouWordmark`                                                                | Approved aspect ratio and theme-aware foreground                                                                                                                                 |
| `OkouCloseButton`, `OkouLabeledValue`                                         | Native toolbar dismissal and width-adaptive label/value information                                                                                                              |
| `OkouProviderButtonStyle`                                                     | Full-width provider action with a branded icon and explicit provider name; neutral resting/pressed/disabled states                                                               |
| `OkouAuthTheme`                                                               | Public Clerk integration; retains SDK-owned authentication behavior                                                                                                              |
| `OkouGlassControl`                                                            | Glass icon (`.circle`) or labeled (`.capsule`) control on an exact 44 pt shape; `isProminent` for a bar's one primary action; pairs and bars read at one size                    |
| `OkouFloatingPanelStyle`                                                      | Card surface plus the floating shadow for suggestion panels over the transcript                                                                                                  |
| `okouGroupedBackground()`                                                     | The one ground for grouped List/Form sheets                                                                                                                                      |
| `OkouRunningIndicator`                                                        | Web's breathing running dot; `phaseOffset` staggers list rows into a wave                                                                                                        |
| `ChatCardHeader` / `ChatCardButtonStyle` (`.standard`, `.detail`, `.primary`) | Web card heading (16 pt brand-text glyph, callout medium title, one detail style) and card actions (outline, primary, text; destructive role in red)                             |
| `NewChatGreeting`                                                             | New-chat greeting with Web's word-by-word entrance                                                                                                                               |
| `ConnectorLogo`                                                               | Partner catalog logo (PNG/SVG) in a 24 pt slot with a glyph fallback                                                                                                             |
| `OkouUsageMeter`                                                              | Allowance row: label, "% remaining", capacity bar (normal / low / exhausted), reset time                                                                                         |
| `okouSectionHeader()`, `okouSectionNote()`                                    | Grouped-list section header (15 pt medium) and footer note (13 pt muted)                                                                                                         |
| `okouValuePicker()`                                                           | Menu picker whose trailing value is supporting text                                                                                                                              |
| `OkouRowLabel`                                                                | Row title with its leading graphic in the shared 28 pt slot                                                                                                                      |
| `OkouValueRow`                                                                | A grouped row with a trailing value (system Settings style): the title keeps one line, the 17 pt muted value yields and truncates in the middle                                  |
| `OkouInlineCodeChip`                                                          | Web-style inline code in Markdown: padding and a 4 pt corner, on the sentence's baseline without growing the line; short spans only, off under VoiceOver                         |
| `OkouProfileAvatar`                                                           | The signed-in person's photo in a circle with a hairline; account glyph without a photo (sidebar Settings, Settings profile row)                                                 |
| `OkouAgentTile`                                                               | An agent in a sideways avatar rail: 56 pt avatar, one 11 pt line of name ending in "…", selected tile, unread dot                                                                |
| `OkouLiveWaveform`                                                            | Dictation waveform: one bar per level sample, gliding every frame, newest growing in at the trailing edge, baseline dots before audio; static under Reduce Motion                |
| `OkouChip` / `OkouChipRail`                                                   | Filter chips in a sideways-scrolling row starting on the content edge; selected / unselected                                                                                     |
| `OkouLogoTile`                                                                | A partner logo or glyph on a quiet square tile (44 / 64 pt) so catalog marks line up                                                                                             |
| `OkouAddIndicator`                                                            | A catalog card's trailing "+" (add now) or filled check (added), 32 pt in a 44 pt target                                                                                         |
| `okouSegmented()`                                                             | Large segmented picker for a page-level switch                                                                                                                                   |
| Feature components                                                            | Compose the foundations for domain-specific information; promote only reusable visual/interaction patterns into DesignSystem                                                     |

[`OkouDesignSystemCatalog.swift`](../../ios/Okou/DesignSystem/OkouDesignSystemCatalog.swift)
is a live SwiftUI reference with light, dark, and large-text previews. It includes
foundations, component states, and the complete registered icon set. In a Debug
scheme, the `--mobile-design-system` launch argument opens this catalog without
initializing authentication or product services. Release builds do not expose it.

The catalog's **Native icon calibration** section includes native SF Symbol and
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
3. Register new Lucide names in `DesignSystem/icons.json`; regenerate rather
   than drawing substitute paths. Keep its version aligned with both Web
   dependencies. The script verifies the official archive's SHA-512 integrity
   and preserves the ISC/MIT license. The manifest owns the native 2-unit stroke;
   it deliberately differs from Web’s 1.5-unit optical weight.
4. Document any necessary platform exception here with its owner and reason.
   A one-screen visual preference does not justify a new global token.
5. Verify resource loading and relevant behavior, then explicitly inspect native
   rendering, keyboard behavior, large text, light/dark, and the supported OS
   boundary. Follow [native testing rules](ios-testing.md); ordinary visual
   acceptance is not a new screenshot admission test suite.

```sh
python3 ios/scripts/sync-design-tokens.py
python3 ios/scripts/sync-design-assets.py
python3 ios/scripts/sync-design-tokens.py --check
python3 ios/scripts/sync-design-assets.py --check
python3 ios/scripts/sync-agent-avatars.py --check
python3 ios/scripts/sync-workspace-assets.py --check
xcrun swift-format lint --strict --recursive ios/Okou ios/OkouTests ios/Push
```

After native acceptance, restore the preview simulator to the standard text size and appearance before handing it back. Large-text inspection must be identified as an accessibility test, not presented as the default component scale.

The asset script accepts `--archive /path/to/lucide-static-VERSION.tgz` for a
cached official archive; integrity validation still applies. Never edit generated
Swift colors, icon maps, vector paths, or generated color assets manually.
