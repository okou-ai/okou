import CCStateSwiftUI
import ChatData
import SwiftUI

/// The card, its directions and the dock stay in reach at the bottom, as a chat's latest turn
/// and its composer do, all standing on one plain ground with the brand texture across the top.
///
/// The cards lie in a deck, and only the one in front can be read: it stays until it is
/// handled, by a direction, the member's own direction or Dismiss, and the next one rises out of
/// the deck into its place. Nothing pages to another card, so the reader settles each one in
/// turn.
struct ForYouView: View {
  let workspace: WorkspaceStore
  let showChat: () -> Void
  let goBack: () -> Void
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var action: Task<Void, Never>?
  /// The direction just chosen, which shows its progress until the choice settles.
  @State private var pendingOptionID: String?
  /// Where the card in front sits on screen, so a tap around it can put the input away.
  @State private var frontPlacement: ForYouCardPlacement?
  /// The room between the header and the dock, where the card and the deck stand.
  @State private var roomFrame: CGRect = .zero
  /// The visit's deck, kept in the workspace session's Store.
  @ResolvedValue private var resolvedDeck: ForYouStore.Deck?
  private var store: ForYouStore { workspace.forYou }
  /// This render's visit: the deck's cards, phases and notices. The synchronous read only covers
  /// a missing first resolution.
  private var visit: ForYouStore.Deck { resolvedDeck ?? store.deck }

  init(workspace: WorkspaceStore, showChat: @escaping () -> Void, goBack: @escaping () -> Void) {
    self.workspace = workspace
    self.showChat = showChat
    self.goBack = goBack
    _resolvedDeck = ResolvedValue(workspace.forYou.deckValue)
  }

  /// The deck's layers peek this far below one another under the front card, as on the web.
  private static let layerDrop: CGFloat = 8
  private static let layerCount = 2
  /// A layer is this much narrower than the card above it.
  private static let layerInset: CGFloat = 0.04
  /// Each deeper layer shows this much less of itself, so the stack recedes into the ground, lighter
  /// rather than darker, as a stack of notifications or passes does.
  private static let layerFade: Double = 0.14
  /// The big card's ground: white by day, as a grouped sheet's rows are on their grouped ground,
  /// so the card stands clear of the page. At night it is a step darker than the directions.
  static let ground = Color(
    uiColor: UIColor { traits in
      UIColor(traits.userInterfaceStyle == .dark ? OkouColor.background50 : OkouColor.card)
        .resolvedColor(with: traits)
    })
  /// A direction's fill: a step back from the white card by day (`background-50`), and a step
  /// up from the card at night, so each direction reads as a button on it in both schemes.
  static let directionFill = Color(
    uiColor: UIColor { traits in
      UIColor(traits.userInterfaceStyle == .dark ? OkouColor.card : OkouColor.background50)
        .resolvedColor(with: traits)
    })
  /// The card's padding above and below its content (`surface`).
  private static let cardPadding = ForYouCardInset.top + ForYouCardInset.bottom
  /// However low the ground lies, a card may always take this much of the page.
  private static let minimumRoomShare: CGFloat = 0.6
  /// How long a confirmation stays while left alone, as the chat's finished-action feedback.
  private static let confirmationLife: Duration = .seconds(6)

  var body: some View {
    layout
      .modifier(ForYouHaptics(deck: visit))
      .task(id: readingID) { if let id = readingID { await store.read(id) } }
      .onDisappear {
        action?.cancel()
        store.closeDirection()
      }
  }

  private var layout: some View {
    VStack(spacing: 0) {
      ForYouHeader(isBusy: visit.busy, back: goBack)
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay { if isComposing { aroundCard } }
        .overlay(alignment: .top) { notices }
      dock
    }
    // A card settling, a confirmation arriving or the dock coming and going moves the page as one
    // spring instead of jumping it.
    .animation(dockMotion, value: layoutKey)
    .background {
      ForYouCover(veiled: isComposing)
        .animation(dockMotion, value: isComposing)
    }
    .background(OkouColor.background)
    .composerSuggestionOverlay()
  }

  private var readingID: String? { phase == .active ? visit.current?.id : nil }

  /// While a direction is being written, a tap anywhere around its card puts it away: an empty
  /// one folds back into its pill, one with text only lowers the keyboard. The card itself stays
  /// in reach, so the rest of a long one can still be read.
  private var aroundCard: some View {
    GeometryReader { proxy in
      let frame = proxy.frame(in: .global)
      let card = frontPlacement.map { card in
        CGRect(
          x: (frame.width - card.width) / 2, y: card.minY - frame.minY, width: card.width,
          height: card.height)
      }
      Color.clear
        .contentShape(ForYouAroundCard(card: card), eoFill: true)
        .onTapGesture(perform: collapseDirection)
    }
    .accessibilityHidden(true)
  }

  /// Everything whose change reshapes the page: the cards, the confirmation, whether the dock
  /// shows, and which panel stands in for the cards.
  private var layoutKey: [String] {
    let panel =
      !visit.cards.isEmpty ? "cards" : visit.error != nil ? "error" : visit.loaded ? "rest" : "load"
    return visit.cards.map(\.id) + [
      panel, visit.error ?? "", visit.notice?.text ?? "", hasDock ? "dock" : ""
    ]
  }

  private var hasDock: Bool {
    guard case .suggestion = visit.current?.content else { return false }
    return true
  }

  private var isComposing: Bool {
    guard let direction = visit.direction else { return false }
    return direction.cardID == visit.current?.id
  }

  // MARK: Deck

  /// The cards still to come, peeking under the card in front as the web's stack does. Every
  /// card fills the same room, so the layers lie in that room whichever card is in front, and
  /// stay put while a handled card sinks away and the next one rises.
  @ViewBuilder private var deck: some View {
    let layers = min(Self.layerCount, visit.cards.count - 1)
    if layers > 0, !isComposing, let room = cardRoom(asContext: false) {
      ForYouDeckLayers(
        count: layers, ground: Self.ground, drop: Self.layerDrop, inset: Self.layerInset,
        fade: Self.layerFade
      )
      .frame(height: room + Self.cardPadding)
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg)
      .padding(.top, OkouSpace.xxl)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  // MARK: Header and notices

  /// What the page has to say floats under the header, over the scene, so the deck never moves
  /// and the card's directions are never covered. A failure stays until it is dismissed. An
  /// enabled automation is a plain toast that lifts away after a few idle seconds or a sideways
  /// swipe; a message sent or a card turned down says nothing, as the card leaving is enough.
  /// Each drops in from under the header, and a new one replaces the last in place.
  @ViewBuilder private var notices: some View {
    Group {
      if let error = visit.error, visit.current != nil {
        OkouBanner(Text(error), icon: "circle-alert", tone: .problem, dismiss: clearError)
          .disabled(visit.busy)
          .padding(.top, OkouSpace.sm)
          .id(error)
          .transition(noticeTransition)
      } else if let notice = visit.notice {
        confirmation(notice)
      }
    }
    .frame(maxWidth: OkouControl.readableWidth)
    .padding(.horizontal, OkouSpace.lg)
  }

  /// A plain toast: there is nothing to undo or open, so it holds no control.
  private func confirmation(_ notice: ForYouStore.Notice) -> some View {
    ChatFeedbackSurface(
      message: notice.text, icon: "circle-check", showsDismiss: false,
      autoDismissAfter: Self.confirmationLife, action: {}, dismiss: clearNotice
    )
    .id(notice.text)
    .transition(noticeTransition)
  }

  // MARK: Cards

  /// The cards, or the one panel that stands in for them. A panel takes over from the deck by
  /// rising into the card's place as the last card leaves.
  @ViewBuilder private var content: some View {
    if !visit.cards.isEmpty {
      cards.transition(.opacity)
    } else if let error = visit.error {
      standalone {
        OkouLoadErrorRow(message: error, retry: { run { await store.load() } })
      }
      .transition(panelTransition)
    } else if visit.loaded {
      standalone {
        ForYouCaughtUp(done: goBack).disabled(visit.busy)
      }
      .transition(panelTransition)
    } else {
      standalone(foot: deckFoot(asContext: false)) {
        ForYouLoadingCard(height: cardRoom(asContext: false))
      }
      .transition(.opacity)
    }
  }

  private var panelTransition: AnyTransition {
    reduceMotion
      ? .opacity
      : .opacity.combined(with: .offset(y: OkouSpace.xxl)).combined(with: .scale(scale: 0.96))
  }

  /// The card in front, alone: only it can be read, and it stays until it is handled. It takes
  /// exactly the room between the header and the dock, with the deck's layers under it.
  private var cards: some View {
    ZStack {
      if let card = visit.current {
        page(card)
          // A handled card sinks away where it stood while the next one rises into its place.
          .transition(cardChange)
          .id(card.id)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { deck }
    .onGeometryChange(for: CGRect.self) {
      $0.frame(in: .global)
    } action: {
      roomFrame = $0
    }
    // A card that scrolls up under the header, as it does above the keyboard, fades out
    // there instead of being cut.
    .mask {
      VStack(spacing: 0) {
        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
          .frame(height: OkouSpace.xxl)
        Rectangle()
      }
    }
  }

  private func page(_ card: ForYouCard) -> some View {
    let asContext = visit.direction?.cardID == card.id
    return ScrollView {
      surface(reportsPlacement: true, asContext: asContext) {
        cardView(card, height: cardRoom(asContext: asContext))
          .disabled(visit.busy)
      }
      .padding(.top, OkouSpace.xxl)
      .padding(.bottom, deckFoot(asContext: asContext))
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    // The card hangs from its top edge, just under the header: when the room changes, as the
    // input grows out of its pill or the keyboard rises, only its foot moves, up and back down,
    // and its top never jumps.
    .defaultScrollAnchor(.top, for: .alignment)
    .defaultScrollAnchor(.top, for: .sizeChanges)
    .scrollIndicators(.hidden)
    // A card that fits stays put: only one taller than the room (large text, the keyboard up)
    // scrolls, so a vertical drag never pulls the card down off the deck.
    .scrollBounceBehavior(.basedOnSize, axes: .vertical)
    .scrollDismissesKeyboard(.interactively)
  }

  /// A handled card is gone quickly, sinking as it fades, so the card rising behind it never
  /// shows through it for long. The next card rises straight out of the deck, from where its
  /// first layer lies (a little lower and narrower), and turns solid early in its rise.
  private var cardChange: AnyTransition {
    reduceMotion
      ? .opacity
      : .asymmetric(
        insertion: .modifier(
          active: ForYouCardRise(progress: 0, drop: Self.layerDrop, inset: Self.layerInset),
          identity: ForYouCardRise(progress: 1, drop: Self.layerDrop, inset: Self.layerInset)),
        removal: .opacity.combined(with: .scale(scale: Self.exitScale, anchor: .bottom))
          .animation(.easeOut(duration: Self.exitDuration)))
  }

  private static let exitScale: CGFloat = 0.94
  private static let exitDuration: Double = 0.14

  /// A standalone panel: the caught-up card, or loading and its failure.
  /// It measures the same room the card does, so a skeleton can take a card's exact height.
  private func standalone<Content: View>(
    foot: CGFloat = OkouSpace.sm, @ViewBuilder _ content: () -> Content
  ) -> some View {
    ScrollView {
      surface(content)
        .padding(.top, OkouSpace.xxl)
        .padding(.bottom, foot)
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .alignment)
    .scrollIndicators(.hidden)
    .refreshable { await store.load() }
    .onGeometryChange(for: CGRect.self) {
      $0.frame(in: .global)
    } action: {
      roomFrame = $0
    }
  }

  /// The one surface of the page. The card in front reports where it sits, so a tap around it
  /// can put the input away.
  private func surface<Content: View>(
    reportsPlacement: Bool = false, asContext: Bool = false,
    @ViewBuilder _ content: () -> Content
  ) -> some View {
    // The card's large corner takes room from its content, so the text keeps well clear of the
    // edge: more above the heading, where the corner curves.
    content()
      .padding(.horizontal, ForYouCardInset.side)
      .padding(.top, ForYouCardInset.top)
      .padding(.bottom, asContext ? ForYouCardInset.textBottom : ForYouCardInset.bottom)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous).fill(Self.ground)
          .overlay {
            RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
              .strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline)
          }
      }
      .onGeometryChange(for: ForYouCardPlacement.self) { proxy in
        ForYouCardPlacement(proxy.frame(in: .global))
      } action: { placement in
        if reportsPlacement { frontPlacement = placement }
      }
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg)
  }

  /// The content height a card may take: from just under the header down to the deck's place
  /// above the dock, on every phone, so the page keeps one composition and the deck one shape.
  /// A card longer than the room scrolls its heading while its actions stay at the bottom. The
  /// card a direction is written for keeps only its heading, as tall as it is within the room
  /// above the input.
  private func cardRoom(asContext: Bool) -> CGFloat? {
    guard roomFrame.height > 0 else { return nil }
    let bottom = roomFrame.maxY - deckFoot(asContext: asContext)
    let top = roomFrame.minY + OkouSpace.xxl
    if asContext {
      let padding = ForYouCardInset.top + ForYouCardInset.textBottom
      return max(bottom - top - padding, OkouControl.minimumTarget)
    }
    let room = max(bottom - top, roomFrame.height * Self.minimumRoomShare)
    return room - Self.cardPadding
  }

  /// The room under a card, where the deck's layers peek out. The card a direction is written
  /// for has no layers under it, so it keeps only the gap above the input.
  private func deckFoot(asContext: Bool) -> CGFloat {
    asContext ? OkouSpace.sm : Self.layerDrop * CGFloat(Self.layerCount) + OkouSpace.sm
  }

  @ViewBuilder private func cardView(_ card: ForYouCard, height: CGFloat?) -> some View {
    switch card.content {
    case .suggestion(let suggestion):
      ForYouSuggestionView(
        suggestion: suggestion, height: height,
        pendingOptionID: pendingOptionID, isContext: visit.direction?.cardID == card.id,
        openSource: { id in run { await store.openSource(id) } },
        choose: { option in
          guard !store.busy else { return }
          pendingOptionID = option.id
          run {
            defer { pendingOptionID = nil }
            if await store.choose(card, option: option) { showChat() }
          }
        })
    case .automation(let event):
      ForYouAutomationView(
        event: event, height: height,
        enable: { run { await store.resolve(card, event: event, enable: true) } },
        dismiss: { run { await store.resolve(card, event: event, enable: false) } })
    case .unsupported: EmptyView()
    }
  }

  // MARK: Dock

  /// Below a suggestion, where a chat keeps its composer: the member's own direction, and the
  /// one way to turn the suggestion down. The input grows out of the pill in place, as the
  /// web's does, and shrinks back into it.
  @ViewBuilder private var dock: some View {
    if let card = visit.current, case .suggestion(let suggestion) = card.content {
      ZStack(alignment: .bottom) {
        if let direction = visit.direction, direction.cardID == card.id {
          ForYouDirectionComposer(
            direction: direction, card: card, suggestion: suggestion, workspace: workspace
          )
          .transition(reduceMotion ? .opacity : .forYouInputGrowth)
          .accessibilityAction(.escape, collapseDirection)
        } else {
          restingDock(card)
            .transition(.opacity)
        }
      }
      .animation(dockMotion, value: isComposing)
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg).padding(.bottom, OkouSpace.sm)
      .disabled(visit.busy)
      // A paused automation has no dock: it sinks away, and comes back with the next suggestion.
      .transition(reduceMotion ? .opacity : .offset(y: OkouSpace.lg).combined(with: .opacity))
    } else if visit.current != nil || (!visit.loaded && visit.error == nil) {
      // Its room stays, so the deck keeps one place and the card's top edge never moves; while
      // the first cards load it is kept too, so the skeleton stands where the card will.
      Color.clear
        .frame(height: OkouControl.minimumTarget + OkouSpace.md)
        .padding(.bottom, OkouSpace.sm)
        .accessibilityHidden(true)
    }
  }

  /// The sidebar footer's pair, so the page's bar reads as the app's: a prompt in the placeholder
  /// grey on a glass capsule, as New Message is, to write a direction, and a round glass glyph, as
  /// Search is, to turn the suggestion down.
  private func restingDock(_ card: ForYouCard) -> some View {
    HStack(spacing: OkouSpace.sm) {
      Button {
        // The page moves with the input as it grows: the card rises with the dock.
        if !withAnimation(dockMotion, { store.openListedDirection(card) }) {
          run { await store.openDirection(card) }
        }
      } label: {
        Label("What do you have in mind?", okouSymbol: "square-pen")
          .font(.okou(.body))
          .foregroundStyle(OkouColor.placeholder)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouGlassControl(shape: .capsule))
      }
      .accessibilityHint("Ask a question or describe what you’d like to do.")
      .accessibilityIdentifier("for-you-direction")
      Menu {
        // The web's four answers to "How is this suggestion?", then leaving without one.
        Section("Tell Okou why. It shapes what comes next.") {
          ForEach(ForYouFeedback.allCases, id: \.self) { reason in
            Button(reason.title, okouSymbol: reason.icon) {
              run { await store.respond(card, reason: reason) }
            }
          }
        }
        Button("Just dismiss", okouSymbol: "x") {
          run { await store.respond(card, reason: nil) }
        }
      } label: {
        OkouToolbarIcon("x").modifier(OkouGlassControl(shape: .circle))
      }
      .menuOrder(.fixed)
      .accessibilityLabel("Dismiss")
      .accessibilityIdentifier("for-you-dismiss")
    }
    .buttonStyle(.plain)
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
  }

  private var dockMotion: Animation? {
    reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86)
  }

  private func collapseDirection() {
    guard let direction = store.direction else { return }
    if direction.composer.hasContent {
      direction.composer.editor.dismissKeyboard()
    } else {
      withAnimation(dockMotion) { store.closeDirection() }
    }
  }

  private func clearNotice() { withAnimation(dockMotion) { store.notice = nil } }

  private func clearError() { withAnimation(dockMotion) { store.error = nil } }

  private var noticeTransition: AnyTransition {
    reduceMotion ? .opacity : .offset(y: -OkouSpace.lg).combined(with: .opacity)
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
  }
}

/// A haptic marks what was committed: a card handled, or a failure.
private struct ForYouHaptics: ViewModifier {
  let deck: ForYouStore.Deck

  func body(content: Content) -> some View {
    content
      .sensoryFeedback(.success, trigger: deck.handled.count, condition: Self.grew)
      .sensoryFeedback(.error, trigger: deck.error, condition: Self.appeared)
  }

  private static func grew(_ old: Int, _ new: Int) -> Bool { new > old }
  private static func appeared(_ old: String?, _ new: String?) -> Bool { new != nil }
}

/// A card's place on screen. It stands centred in the room, so only its top and size are kept.
private struct ForYouCardPlacement: Equatable, Sendable {
  let minY: CGFloat
  let width: CGFloat
  let height: CGFloat

  init(_ frame: CGRect) {
    self.init(minY: frame.minY, width: frame.width, height: frame.height)
  }

  init(minY: CGFloat, width: CGFloat, height: CGFloat) {
    self.minY = minY
    self.width = width
    self.height = height
  }
}

/// The room around the card, where a tap puts the input away; the card itself is left out.
private struct ForYouAroundCard: Shape {
  let card: CGRect?

  func path(in rect: CGRect) -> Path {
    var path = Path(rect)
    if let card {
      path.addRoundedRect(
        in: card, cornerSize: CGSize(width: OkouRadius.sheet, height: OkouRadius.sheet),
        style: .continuous)
    }
    return path
  }
}

/// A card rising out of the deck into the front: from where the deck's first layer lies, a
/// little lower and narrower, turning solid early in its rise.
private struct ForYouCardRise: ViewModifier {
  let progress: CGFloat
  let drop: CGFloat
  let inset: CGFloat
  /// The share of the rise after which the card is solid.
  private static let solid: CGFloat = 0.3

  func body(content: Content) -> some View {
    content
      .offset(y: (1 - progress) * drop)
      .scaleEffect(x: 1 - (1 - progress) * inset, y: 1, anchor: .bottom)
      .opacity(Double(min(1, progress / Self.solid)))
  }
}

/// The input opening out of its pill: it starts at about the pill's size where the pill sits,
/// at the dock's leading edge, and grows to its own size as it fades in.
private struct ForYouInputGrowth: ViewModifier {
  let progress: CGFloat

  func body(content: Content) -> some View {
    content
      .scaleEffect(x: 0.72 + 0.28 * progress, y: 0.32 + 0.68 * progress, anchor: .bottomLeading)
      .opacity(Double(progress))
  }
}

extension AnyTransition {
  fileprivate static var forYouInputGrowth: AnyTransition {
    .modifier(active: ForYouInputGrowth(progress: 0), identity: ForYouInputGrowth(progress: 1))
  }
}
