import ChatData
import SwiftUI

/// The card, its directions and the dock stay in reach at the bottom, as a chat's latest turn
/// and its composer do, all standing on one scene: the cover across the top and its sea below.
///
/// The cards lie in a deck. A sideways swipe anywhere on the page carries the front card with
/// the finger, the next one rises out of the deck behind it, and the cover drifts far more
/// slowly than either, so the page reads in depth. The front card only travels: it never tilts,
/// because nothing is thrown away by paging. Under Reduce Motion the cards simply page side by
/// side and the cover holds still.
struct ForYouView: View {
  let workspace: WorkspaceStore
  let showChat: () -> Void
  let goBack: () -> Void
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var action: Task<Void, Never>?
  /// The direction just chosen, which shows its progress until the choice settles.
  @State private var pendingOptionID: String?
  /// The card the pager rests on.
  @State private var pageID: String?
  /// The pager's place in cards while it moves: 1.5 is halfway from the second to the third,
  /// -1 the copy of the last card before the first, and the card count the copy of the first.
  @State private var pagePosition: CGFloat = 0
  /// Where each card sits on screen, so the cover and the deck follow the card in front.
  @State private var cardPlacements: [String: ForYouCardPlacement] = [:]
  /// The caught-up, loading or error panel, which stands alone without a pager.
  @State private var panelPlacement: ForYouCardPlacement?
  @State private var pagerFrame: CGRect = .zero
  /// Whether the pager has been put on the card in front since it appeared. Until then it rests
  /// on its first page, the copy of the last card, and what it reports is not the reader's.
  @State private var pagerPlaced = false
  /// The train's lower edge on screen; a card never rises above it.
  @State private var horizon: CGFloat = 0
  /// The card on top of the deck while the pager moves: the one it rested on when the move began.
  /// It is thrown off the deck whichever way it goes, and every other card waits under it.
  @State private var topPageID: String?
  /// Whether the pager is moving, by the finger or on its own.
  @State private var isPaging = false
  private var store: ForYouStore { workspace.forYou }

  /// The deck's layers peek this far below one another under the front card, as on the web.
  private static let layerDrop: CGFloat = 8
  private static let layerCount = 2
  /// A layer is this much narrower than the card above it.
  private static let layerInset: CGFloat = 0.03
  /// A rising card is solid once this share of a page has been swiped, so it reads as the card
  /// under the one thrown off rather than a ghost behind it.
  private static let riseSolid: CGFloat = 0.3
  /// How much smaller the top card is a whole page away, as it is thrown off the deck.
  private static let leaveShrink: CGFloat = 0.04
  /// Each deeper layer of the deck is shaded by this much more, so the stack recedes while every
  /// layer stays a solid card on the scene.
  private static let layerShade: Double = 0.06
  /// The big card's ground, a step back from white, so the white directions on it show their
  /// outline and the mark on each corner reads as part of its button's shape. At night it is a
  /// step darker than the directions, for the same reason.
  static let ground = OkouColor.background50
  /// The card's padding above and below its content (`surface`).
  private static let cardPadding = ForYouCardInset.top + ForYouCardInset.bottom
  /// However low the ground lies, a card may always take this much of the page.
  private static let minimumRoomShare: CGFloat = 0.6
  /// How far the cover drifts for each card, so it moves well behind the cards.
  private static let coverDrift: CGFloat = 36
  /// How long a confirmation stays while left alone, as the chat's finished-action feedback.
  private static let confirmationLife: Duration = .seconds(6)

  var body: some View {
    layout
      .modifier(ForYouHaptics(store: store))
      .task(id: readingID) { if let id = readingID { await store.read(id) } }
      .onChange(of: store.current?.id, initial: true) { _, id in
        if ForYouLoop.cardID(pageID) != id { pageID = id }
      }
      .onChange(of: pageID) { _, id in
        if let id = ForYouLoop.cardID(id) { store.show(id) }
        noteRest(id)
      }
      .onDisappear {
        action?.cancel()
        store.closeDirection()
      }
  }

  private var layout: some View {
    VStack(spacing: 0) {
      ForYouHeader(
        count: store.cards.count, live: livePosition, position: pagePosition,
        isBusy: store.busy, canPage: !store.busy && !isComposing, showsPlace: !isComposing,
        back: goBack, show: show)
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
      ForYouCover(
        drift: reduceMotion ? 0 : loop.unwrapped(pagePosition) * Self.coverDrift,
        veiled: isComposing, onHorizon: noteHorizon
      )
      .animation(dockMotion, value: isComposing)
    }
    .background(OkouColor.background)
    .composerSuggestionOverlay()
  }

  private var readingID: String? { phase == .active ? store.current?.id : nil }

  /// While a direction is being written, a tap anywhere around its card puts it away: an empty
  /// one folds back into its pill, one with text only lowers the keyboard. The card itself stays
  /// in reach, so the rest of a long one can still be read.
  private var aroundCard: some View {
    GeometryReader { proxy in
      let frame = proxy.frame(in: .global)
      let card = front.map { card in
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
      !store.cards.isEmpty ? "cards" : store.error != nil ? "error" : store.loaded ? "rest" : "load"
    return store.cards.map(\.id) + [
      panel, store.error ?? "", store.notice?.text ?? "", store.notice?.undo?.undoID ?? "",
      hasDock ? "dock" : ""
    ]
  }

  private var hasDock: Bool {
    guard case .suggestion = store.current?.content else { return false }
    return true
  }

  private var isComposing: Bool {
    guard let direction = store.direction else { return false }
    return direction.cardID == store.current?.id
  }

  private var loop: ForYouLoop { ForYouLoop(store.cards) }

  /// The card the pager is closest to while it moves, counting round the deck.
  private var livePosition: Int { loop.index(nearest: pagePosition) }

  // MARK: Cover and deck

  /// The card in front, part way between two cards while the pager moves.
  private var front: ForYouCardPlacement? {
    let loop = loop
    let pages = loop.pages
    guard !pages.isEmpty else { return panelPlacement }
    let position = min(max(pagePosition + CGFloat(loop.lead), 0), CGFloat(pages.count - 1))
    let lower = Int(position.rounded(.down))
    let upper = min(lower + 1, pages.count - 1)
    guard let from = cardPlacements[pages[lower].id] else { return nil }
    let target = cardPlacements[pages[upper].id] ?? from
    return from.blended(with: target, by: position - CGFloat(lower))
  }

  /// The cards still to come, peeking under the card in front as the web's stack does. They
  /// stay put while the cards above them move.
  @ViewBuilder private var deck: some View {
    let layers = min(Self.layerCount, store.cards.count - 1)
    if layers > 0, let front, !isComposing {
      ForYouDeckLayers(
        count: layers, ground: Self.ground, drop: Self.layerDrop, inset: Self.layerInset,
        shade: Self.layerShade
      )
      .frame(width: front.width, height: front.height)
      .offset(x: (pagerFrame.width - front.width) / 2, y: front.minY - pagerFrame.minY)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  // MARK: Header and notices

  /// What the page has to say floats under the header, over the scene, so the deck never moves
  /// and the card's directions are never covered. A failure stays until it is dismissed. A
  /// finished action ("Noted for later · Undo") is the chat's feedback surface and
  /// lifts away after a few idle seconds or a sideways swipe, its Undo kept in the caught-up
  /// recap. Each drops in from under the header, and a new one replaces the last in place.
  @ViewBuilder private var notices: some View {
    Group {
      if let error = store.error, store.current != nil {
        OkouBanner(Text(error), icon: "circle-alert", tone: .problem, dismiss: clearError)
          .disabled(store.busy)
          .padding(.top, OkouSpace.sm)
          .id(error)
          .transition(noticeTransition)
      } else if let notice = store.notice {
        confirmation(notice)
      }
    }
    .frame(maxWidth: OkouControl.readableWidth)
    .padding(.horizontal, OkouSpace.lg)
  }

  private func confirmation(_ notice: ForYouStore.Notice) -> some View {
    ChatFeedbackSurface(
      message: notice.text, icon: "circle-check",
      actionTitle: notice.undo != nil
        ? String(localized: "Undo")
        : notice.threadID != nil ? String(localized: "Open chat") : nil,
      actionEnabled: !store.busy,
      actionIdentifier: notice.undo != nil ? "for-you-undo" : "for-you-open-chat",
      autoDismissAfter: Self.confirmationLife, action: { act(on: notice) },
      dismiss: clearNotice
    )
    .id(notice.undo?.undoID ?? notice.text)
    .transition(noticeTransition)
  }

  private func act(on notice: ForYouStore.Notice) {
    if let undo = notice.undo {
      run { await store.undo(undo) }
    } else if let id = notice.threadID {
      run { if await store.open(id) { showChat() } }
    }
  }

  // MARK: Cards

  /// The cards, or the one panel that stands in for them. A panel takes over from the deck by
  /// rising into the card's place as the last card leaves.
  @ViewBuilder private var content: some View {
    if !store.cards.isEmpty {
      pager.transition(.opacity)
    } else if let error = store.error {
      standalone {
        OkouLoadErrorRow(message: error, retry: { run { await store.load() } })
      }
      .transition(panelTransition)
    } else if store.loaded {
      standalone {
        ForYouCaughtUp(
          handled: store.handled,
          undo: { undo in run { await store.undo(undo) } },
          open: { id in run { if await store.open(id) { showChat() } } },
          done: goBack
        )
        .disabled(store.busy)
      }
      .transition(panelTransition)
    } else {
      standalone {
        ForYouLoadingCard()
      }
      .transition(.opacity)
    }
  }

  private var panelTransition: AnyTransition {
    reduceMotion
      ? .opacity
      : .opacity.combined(with: .offset(y: OkouSpace.xxl)).combined(with: .scale(scale: 0.96))
  }

  /// One page per card, each as wide as the screen, so the whole page follows a sideways
  /// swipe and comes to rest on a card when the finger lets go. The pages take exactly the
  /// room between the header and the dock: a horizontal scroll view is as tall as its pages.
  private var pager: some View {
    let loop = loop
    let pages = loop.pages
    // The card on top: the one the pager last rested on, or the one in front when that one has
    // left the deck.
    let rested = pages.contains { $0.id == topPageID } ? topPageID : nil
    let top = rested ?? pageID ?? store.current?.id
    return GeometryReader { viewport in
      ScrollViewReader { proxy in
        ScrollView(.horizontal) {
          HStack(spacing: 0) {
            ForEach(pages) { page in
              self.page(page, isTop: page.id == top)
                .frame(width: viewport.size.width, height: viewport.size.height)
                // A handled card sinks away where it stood while the next one rises into its place.
                .transition(cardExit)
                // The top card lies over the deck as it is thrown off either side.
                .zIndex(page.id == top ? 1 : 0)
                .accessibilityHidden(page.id != store.current?.id)
            }
          }
          .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(
          id: Binding(get: { pageID ?? store.current?.id }, set: { if pagerPlaced { pageID = $0 } })
        )
        .scrollIndicators(.hidden)
        .scrollDisabled(isComposing || store.busy)
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
          geometry.containerSize.width > 0
            ? geometry.contentOffset.x / geometry.containerSize.width : 0
        } action: { _, position in
          pagePosition = position - CGFloat(loop.lead)
        }
        // Coming to rest on a copy at either end hands over to the card itself, in place, so the
        // next swipe carries on round the deck; the card it rests on is the next move's top card.
        .onScrollPhaseChange { _, phase in
          notePhase(phase)
        }
        // It opens on the card in front once it has its width, and again when the copies at the
        // ends come or go, so it never rests on a copy by accident.
        .onGeometryChange(for: Bool.self) {
          $0.size.width > 0
        } action: { hasWidth in
          if hasWidth { place(proxy) }
        }
        .onChange(of: loop.lead) { place(proxy) }
        .onDisappear { pagerPlaced = false }
      }
    }
    .background(alignment: .topLeading) { deck }
    .onGeometryChange(for: CGRect.self) {
      $0.frame(in: .global)
    } action: {
      pagerFrame = $0
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

  private func notePhase(_ phase: ScrollPhase) {
    isPaging = phase != .idle
    guard phase == .idle else { return }
    handOverFromCopy()
    topPageID = pageID
  }

  /// A card put in front while the pager is still, as when a handled card leaves or one comes
  /// back, is the next move's top card.
  private func noteRest(_ id: String?) {
    if !isPaging { topPageID = id }
  }

  private func handOverFromCopy() {
    guard let id = pageID, let card = ForYouLoop.cardID(id), card != id else { return }
    var handover = Transaction()
    handover.disablesAnimations = true
    withTransaction(handover) { pageID = card }
  }

  private func place(_ proxy: ScrollViewProxy) {
    guard let id = store.current?.id else { return }
    var placement = Transaction()
    placement.disablesAnimations = true
    withTransaction(placement) { proxy.scrollTo(id, anchor: .leading) }
    pageID = id
    topPageID = id
    pagerPlaced = true
  }

  private func page(_ page: ForYouLoop.Page, isTop: Bool) -> some View {
    let riseSolid = Self.riseSolid
    let layerDrop = Self.layerDrop
    let layerInset = Self.layerInset
    let leaveShrink = Self.leaveShrink
    let depth = !reduceMotion
    return ScrollView {
      surface(placementOf: page.id, asContext: store.direction?.cardID == page.card.id) {
        cardView(page.card, height: cardHeight(for: page.card.id))
          .disabled(store.busy)
      }
      .padding(.top, OkouSpace.xxl)
      .padding(.bottom, deckFoot(asContext: store.direction?.cardID == page.card.id))
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .alignment)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollIndicators(.hidden)
    // A card that fits stays put: only one taller than the room (large text, the keyboard up)
    // scrolls, so a vertical drag never pulls the card down off the deck.
    .scrollBounceBehavior(.basedOnSize, axes: .vertical)
    .scrollDismissesKeyboard(.interactively)
    .visualEffect { content, proxy in
      let width = max(proxy.size.width, 1)
      let distance = proxy.frame(in: .scrollView(axis: .horizontal)).minX
      // How far the card is from the front, in pages, whichever side it lies on. The top card
      // goes with the finger, either way, and settles back a little as it is thrown off,
      // without tilting. Every other card waits in the deck under it, centred where the deck's
      // first layer lies (a little lower and narrower), and rises straight out of the deck into
      // the front as the top card goes, turning solid within the first part of the swipe; it
      // never comes in from the side. Without depth all stay flat, so the cards page side by side.
      let away = min(abs(distance) / width, 1)
      let rising = depth && !isTop ? away : 0
      let leaving = depth && isTop ? away : 0
      return
        content
        .offset(x: rising > 0 ? -distance : 0, y: rising * layerDrop)
        .scaleEffect(x: 1 - rising * layerInset, y: 1, anchor: .bottom)
        .scaleEffect(1 - leaving * leaveShrink, anchor: .bottom)
        .opacity(Double(min(1, (1 - rising) / riseSolid)))
    }
  }

  /// A handled card is gone quickly, sinking as it fades, so the card rising behind it never
  /// shows through it for long.
  private var cardExit: AnyTransition {
    reduceMotion
      ? .opacity
      : .asymmetric(
        insertion: .opacity,
        removal: .opacity.combined(with: .scale(scale: Self.exitScale, anchor: .bottom))
          .animation(.easeOut(duration: Self.exitDuration)))
  }

  private static let exitScale: CGFloat = 0.94
  private static let exitDuration: Double = 0.14

  /// A standalone panel: the caught-up card, or loading and its failure.
  private func standalone<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    ScrollView {
      surface(placementOf: nil, content)
        .padding(.top, OkouSpace.xxl)
        .padding(.bottom, OkouSpace.sm)
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .alignment)
    .scrollIndicators(.hidden)
    .refreshable { await store.load() }
  }

  /// The one surface of the page. It reports where it sits, for the cover and the deck: a
  /// card under its id, the standalone panel under none.
  private func surface<Content: View>(
    placementOf id: String?, asContext: Bool = false, @ViewBuilder _ content: () -> Content
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
        guard let id else {
          panelPlacement = placement
          return
        }
        cardPlacements[id] = placement
      }
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg)
  }

  /// The content height a card may take, down to the deck's place above the dock. Paging, it runs
  /// from the train's lower edge, so the train stays in view (the rails and the sea may be
  /// covered), and is never less than most of the page. As the context of a direction being
  /// written, with the scene veiled, it runs from just under the header.
  private func cardRoom(asContext: Bool) -> CGFloat? {
    guard pagerFrame.height > 0 else { return nil }
    let bottom = pagerFrame.maxY - deckFoot(asContext: asContext)
    let top = pagerFrame.minY + OkouSpace.xxl
    if asContext {
      let padding = ForYouCardInset.top + ForYouCardInset.textBottom
      return max(bottom - top - padding, OkouControl.minimumTarget)
    }
    let room = max(bottom - max(top, horizon), pagerFrame.height * Self.minimumRoomShare)
    return room - Self.cardPadding
  }

  /// The room under a card, where the deck's layers peek out. The card a direction is written
  /// for has no layers under it, so it keeps only the gap above the input.
  private func deckFoot(asContext: Bool) -> CGFloat {
    asContext ? OkouSpace.sm : Self.layerDrop * CGFloat(Self.layerCount) + OkouSpace.sm
  }

  /// Every card fills the room from just under the train down to the deck's place above the
  /// dock, on every phone, so the page keeps one composition and the deck one shape as it pages.
  /// A card longer than the room scrolls its heading while its actions stay at the bottom. The
  /// card a direction is written for keeps only its heading, as tall as it is within the room
  /// above the input.
  private func cardHeight(for cardID: String) -> CGFloat? {
    cardRoom(asContext: store.direction?.cardID == cardID)
  }

  private func noteHorizon(_ line: CGFloat) {
    if abs(horizon - line) > OkouSpace.hairline { horizon = line }
  }

  @ViewBuilder private func cardView(_ card: ForYouCard, height: CGFloat?) -> some View {
    switch card.content {
    case .suggestion(let suggestion):
      ForYouSuggestionView(
        suggestion: suggestion, height: height,
        pendingOptionID: pendingOptionID, isContext: store.direction?.cardID == card.id,
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
    if let card = store.current, case .suggestion(let suggestion) = card.content {
      ZStack(alignment: .bottom) {
        if let direction = store.direction, direction.cardID == card.id {
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
      .disabled(store.busy)
      // A paused automation has no dock: it sinks away, and comes back with the next suggestion.
      .transition(reduceMotion ? .opacity : .offset(y: OkouSpace.lg).combined(with: .opacity))
    } else if store.current != nil {
      // Its room stays, so the deck keeps one place and the card's top edge never moves.
      Color.clear
        .frame(height: OkouControl.minimumTarget + OkouSpace.md)
        .padding(.bottom, OkouSpace.sm)
        .accessibilityHidden(true)
    }
  }

  private func restingDock(_ card: ForYouCard) -> some View {
    HStack(spacing: OkouSpace.sm) {
      Button {
        // The page moves with the input as it grows: the card rises with the dock.
        if !withAnimation(dockMotion, { store.openListedDirection(card) }) {
          run { await store.openDirection(card) }
        }
      } label: {
        OkouGlassPrompt("What do you have in mind?", on: .scene)
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
        Label("Dismiss", okouSymbol: "x", iconSize: OkouIconSize.inline)
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.foreground).lineLimit(1)
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouGlassControl(shape: .capsule, surface: .scene))
      }
      .menuOrder(.fixed)
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

  private func show(_ index: Int) {
    guard store.cards.indices.contains(index) else { return }
    // The card in front stays on top and is thrown off as the pager moves to the one chosen.
    if !reduceMotion { isPaging = true }
    withAnimation(reduceMotion ? nil : .smooth) { pageID = store.cards[index].id }
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
  }
}

/// A haptic marks what was committed: a new card coming to rest in front, a card handled, a
/// failure. Nothing plays while the finger moves, and a card leaving the deck or coming back to
/// it is not paging.
private struct ForYouHaptics: ViewModifier {
  let store: ForYouStore

  func body(content: Content) -> some View {
    content
      .sensoryFeedback(.selection, trigger: ForYouPageMark(store), condition: ForYouPageMark.paged)
      .sensoryFeedback(.success, trigger: store.handled.count, condition: Self.grew)
      .sensoryFeedback(.error, trigger: store.error, condition: Self.appeared)
  }

  private static func grew(_ old: Int, _ new: Int) -> Bool { new > old }
  private static func appeared(_ old: String?, _ new: String?) -> Bool { new != nil }
}

/// Which card is in front out of how many, so paging can be told apart from a card leaving the
/// deck or coming back to it.
private struct ForYouPageMark: Equatable {
  let id: String?
  let count: Int

  @MainActor init(_ store: ForYouStore) {
    id = store.current?.id
    count = store.cards.count
  }

  static func paged(_ old: Self, _ new: Self) -> Bool {
    guard old.count == new.count, let previous = old.id else { return false }
    return previous != new.id
  }
}

/// A card's place on screen without its sideways position, which changes on every frame of a
/// swipe while nothing that depends on the placement moves.
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

  func blended(with other: Self, by fraction: CGFloat) -> Self {
    Self(
      minY: minY + (other.minY - minY) * fraction,
      width: width + (other.width - width) * fraction,
      height: height + (other.height - height) * fraction)
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
