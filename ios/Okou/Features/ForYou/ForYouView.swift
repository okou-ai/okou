import ChatData
import SwiftUI

/// The cover fills whatever the card leaves, so the card, its directions and the dock stay
/// in reach at the bottom, as a chat's latest turn and its composer do.
///
/// The cards lie in a deck. A sideways swipe anywhere on the page carries the front card with
/// the finger, the next one rises out of the deck behind it, and the cover drifts far more
/// slowly than either, so the page reads in depth.
struct ForYouView: View {
  let workspace: WorkspaceStore
  let showChat: () -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @Namespace private var dockGlass
  @State private var action: Task<Void, Never>?
  /// The card the pager rests on.
  @State private var pageID: String?
  /// The pager's place in cards while it moves: 1.5 is halfway from the second to the third.
  @State private var pagePosition: CGFloat = 0
  /// Where each card sits on screen, so the cover and the deck follow the card in front.
  @State private var cardPlacements: [String: ForYouCardPlacement] = [:]
  /// The caught-up, loading or error panel, which stands alone without a pager.
  @State private var panelPlacement: ForYouCardPlacement?
  @State private var pagerFrame: CGRect = .zero
  private var store: ForYouStore { workspace.forYou }

  /// The artwork rests on the card's top edge, mostly above it.
  private static let artworkHeight: CGFloat = 72
  private static let artworkRise: CGFloat = 58
  private static let artworkWidth: CGFloat = 96
  /// The deck's layers peek this far below one another under the front card, as on the web.
  private static let layerDrop: CGFloat = 8
  private static let layerCount = 2
  /// A layer is this much narrower than the card above it.
  private static let layerInset: CGFloat = 0.03
  /// How far a card rising out of the deck comes in from the side, as part of the page.
  private static let riseShift: CGFloat = 0.12
  /// A leaving card's tilt a whole page away, in degrees.
  private static let leaveTilt: CGFloat = 6
  /// How far the cover drifts for each card, so it moves well behind the cards.
  private static let coverDrift: CGFloat = 36
  private static let coverAspect: CGFloat = 1024 / 410
  private static let defaultCardTop: CGFloat = 360

  var body: some View {
    VStack(spacing: 0) {
      header
      notices
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay {
          // While a direction is being written, a tap anywhere above the input puts it away:
          // an empty one folds back into its pill, one with text only lowers the keyboard.
          if isComposing {
            Color.clear.contentShape(Rectangle())
              .onTapGesture(perform: collapseDirection)
              .accessibilityHidden(true)
          }
        }
      dock
    }
    .background(alignment: .top) { cover }
    .background(OkouColor.background)
    .composerSuggestionOverlay()
    .task {
      store.beginVisit()
      await store.load()
    }
    .task(id: readingID) { if let id = readingID { await store.read(id) } }
    .onChange(of: store.current?.id, initial: true) { _, id in
      if pageID != id { pageID = id }
    }
    .onChange(of: pageID) { _, id in
      if let id { store.show(id) }
    }
    .interactiveDismissDisabled(store.busy)
    .onDisappear {
      action?.cancel()
      store.closeDirection()
    }
  }

  private var readingID: String? { phase == .active ? store.current?.id : nil }

  private var isComposing: Bool {
    guard let direction = store.direction else { return false }
    return direction.cardID == store.current?.id
  }

  /// The card the pager is closest to while it moves.
  private var livePosition: Int {
    min(max(Int(pagePosition.rounded()), 0), max(store.cards.count - 1, 0))
  }

  // MARK: Cover and deck

  /// The card in front, part way between two cards while the pager moves.
  private var front: ForYouCardPlacement? {
    let cards = store.cards
    guard !cards.isEmpty else { return panelPlacement }
    let position = min(max(pagePosition, 0), CGFloat(cards.count - 1))
    let lower = Int(position.rounded(.down))
    let upper = min(lower + 1, cards.count - 1)
    guard let from = cardPlacements[cards[lower].id] else { return nil }
    let target = cardPlacements[cards[upper].id] ?? from
    return from.blended(with: target, by: position - CGFloat(lower))
  }

  private var cover: some View {
    let aspect = Self.coverAspect
    let drift = max(pagePosition, 0) * Self.coverDrift
    return VStack(spacing: 0) {
      GeometryReader { geometry in
        let width = max(geometry.size.width, geometry.size.height * aspect)
        let travel = max(0, width - geometry.size.width)
        Image("ForYouCover").resizable().scaledToFill()
          .frame(width: width, height: geometry.size.height)
          .offset(x: -min(travel, drift))
          .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
          .clipped()
      }
      .overlay(alignment: .bottom) {
        LinearGradient(
          colors: [OkouColor.background.opacity(0), OkouColor.background],
          startPoint: .top, endPoint: .bottom
        )
        .frame(height: OkouSpace.hero)
      }
      .frame(height: max(0, (front?.minY ?? Self.defaultCardTop) + OkouSpace.section))
      Spacer(minLength: 0)
    }
    .ignoresSafeArea(edges: .top)
    .accessibilityHidden(true)
  }

  /// The cards still to come, peeking under the card in front as the web's stack does. They
  /// stay put while the cards above them move.
  @ViewBuilder private var deck: some View {
    let layers = min(Self.layerCount, store.cards.count - 1)
    if layers > 0, let front, !isComposing {
      ZStack(alignment: .bottom) {
        ForEach(Array((1...layers).reversed()), id: \.self) { layer in
          RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
            .fill(OkouColor.card)
            .overlay {
              RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
                .strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline)
            }
            .scaleEffect(x: 1 - CGFloat(layer) * Self.layerInset, y: 1, anchor: .bottom)
            .offset(y: CGFloat(layer) * Self.layerDrop)
        }
      }
      .frame(width: front.width, height: front.height)
      .offset(x: (pagerFrame.width - front.width) / 2, y: front.minY - pagerFrame.minY)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  // MARK: Header and notices

  private var header: some View {
    VStack(spacing: 0) {
      HStack(spacing: OkouSpace.ten) {
        Button {
          dismiss()
        } label: {
          OkouToolbarIcon("chevron-left").modifier(OkouGlassControl(shape: .circle))
        }
        .buttonStyle(.plain).accessibilityLabel("Back").accessibilityIdentifier("for-you-back")
        .disabled(store.busy)
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text("For you").font(.okou(.title2).weight(.semibold))
          Text("Okou’s picks to handle").font(.okou(.caption))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if store.cards.count > 1 {
          Text(verbatim: "\(livePosition + 1) / \(store.cards.count)")
            .font(.okou(.footnote).weight(.medium)).monospacedDigit()
            .padding(.horizontal, OkouSpace.ten).padding(.vertical, OkouSpace.xs)
            .background(.regularMaterial, in: Capsule())
        }
      }
      if store.cards.count > 1 { progress }
    }
    .foregroundStyle(OkouColor.brandCharcoal)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
  }

  private var progress: some View {
    let count = store.cards.count
    let live = livePosition
    let start = max(0, min(live - 2, count - 5))
    return HStack(spacing: OkouSpace.xs) {
      ForEach(start..<min(start + 5, count), id: \.self) { index in
        Button {
          show(index)
        } label: {
          Capsule().fill(OkouColor.brandCharcoal.opacity(live == index ? 0.85 : 0.24))
            .frame(height: OkouSpace.xs).frame(
              maxWidth: .infinity, minHeight: OkouControl.minimumTarget
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show suggestion \(index + 1) of \(count)")
        .accessibilityAddTraits(index == live ? .isSelected : [])
      }
    }
    .disabled(store.busy || isComposing)
  }

  /// A confirmation sits on the cover, so it never covers the next card's directions.
  @ViewBuilder private var notices: some View {
    Group {
      if let error = store.error, store.current != nil {
        OkouBanner(Text(error), icon: "circle-alert", tone: .problem)
      } else if let notice = store.notice {
        if let undo = notice.undo {
          OkouBanner(Text(notice.text), icon: "circle-check", dismiss: clearNotice) {
            Button("Undo") { run { await store.undo(undo) } }
              .accessibilityIdentifier("for-you-undo")
          }
        } else if let id = notice.threadID {
          OkouBanner(Text(notice.text), icon: "circle-check", dismiss: clearNotice) {
            Button("Open chat") { run { if await store.open(id) { showChat() } } }
          }
        } else {
          OkouBanner(Text(notice.text), icon: "circle-check", dismiss: clearNotice)
        }
      }
    }
    .frame(maxWidth: OkouControl.readableWidth)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
    .disabled(store.busy)
  }

  // MARK: Cards

  @ViewBuilder private var content: some View {
    if !store.cards.isEmpty {
      pager
    } else if let error = store.error {
      standalone {
        VStack(spacing: OkouSpace.md) {
          Text(error).foregroundStyle(OkouColor.mutedForeground)
          Button("Try again") { run { await store.load() } }
        }
        .frame(maxWidth: .infinity).padding(.vertical, OkouSpace.xxl)
      }
    } else if store.loaded {
      standalone { caughtUp }
    } else {
      standalone {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, OkouSpace.hero)
      }
    }
  }

  /// One page per card, each as wide as the screen, so the whole page follows a sideways
  /// swipe and comes to rest on a card when the finger lets go.
  private var pager: some View {
    let cards = store.cards
    return ScrollView(.horizontal) {
      HStack(spacing: 0) {
        ForEach(Array(cards.enumerated()), id: \.element.id) { index, card in
          page(card, isFirst: index == 0)
            .containerRelativeFrame([.horizontal, .vertical])
            // An earlier card lies above a later one, so the front card leaves over the
            // deck and a previous card comes back on top of it.
            .zIndex(Double(cards.count - index))
            .accessibilityHidden(card.id != store.current?.id)
        }
      }
      .scrollTargetLayout()
    }
    .scrollTargetBehavior(.paging)
    .scrollPosition(id: $pageID)
    .scrollIndicators(.hidden)
    .scrollDisabled(isComposing || store.busy)
    .onScrollGeometryChange(for: CGFloat.self) { geometry in
      geometry.containerSize.width > 0
        ? geometry.contentOffset.x / geometry.containerSize.width : 0
    } action: { _, position in
      pagePosition = position
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

  private func page(_ card: ForYouCard, isFirst: Bool) -> some View {
    let riseShift = Self.riseShift
    let layerDrop = Self.layerDrop
    let layerInset = Self.layerInset
    let leaveTilt = Self.leaveTilt
    return ScrollView {
      surface(measure: { cardPlacements[card.id] = $0 }) {
        cardView(card).disabled(store.busy)
      }
      .overlay(alignment: .topTrailing) { artwork(for: card) }
      .padding(.top, Self.artworkRise + OkouSpace.sm)
      .padding(.bottom, Self.layerDrop * CGFloat(Self.layerCount) + OkouSpace.sm)
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .alignment)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollIndicators(.hidden)
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await store.load() }
    .visualEffect { content, proxy in
      let width = max(proxy.size.width, 1)
      let distance = proxy.frame(in: .scrollView(axis: .horizontal)).minX
      // 0 in front. A card still to come waits in the deck (up to 1) instead of beside the
      // front one; a leaving card (down to -1) goes with the finger, tilting away.
      let rising = isFirst ? 0 : min(max(distance / width, 0), 1)
      let leaving = min(max(-distance / width, 0), 1)
      return
        content
        .offset(
          x: rising > 0 ? -distance + rising * width * riseShift : 0,
          y: rising * layerDrop
        )
        .scaleEffect(x: 1 - rising * layerInset, y: 1 - rising * layerInset, anchor: .bottom)
        .opacity(Double(1 - rising))
        .rotationEffect(
          .degrees(Double(-leaving * leaveTilt)), anchor: UnitPoint(x: 0.5, y: 0.85))
    }
  }

  /// A standalone panel: the caught-up card, or loading and its failure.
  private func standalone<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    ScrollView {
      surface(measure: { panelPlacement = $0 }, content)
        .padding(.top, Self.artworkRise + OkouSpace.sm)
        .padding(.bottom, OkouSpace.sm)
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .alignment)
    .scrollIndicators(.hidden)
    .refreshable { await store.load() }
  }

  /// The one surface of the page. It reports where it sits, for the cover and the deck.
  private func surface<Content: View>(
    measure: @escaping (ForYouCardPlacement) -> Void, @ViewBuilder _ content: () -> Content
  ) -> some View {
    content()
      .padding(OkouSpace.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .modifier(OkouSurfaceStyle(radius: OkouRadius.sheet))
      .onGeometryChange(for: ForYouCardPlacement.self) { proxy in
        ForYouCardPlacement(proxy.frame(in: .global))
      } action: { placement in
        measure(placement)
      }
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg)
  }

  @ViewBuilder private func artwork(for card: ForYouCard) -> some View {
    if let name = store.illustration(for: card), !typeSize.isAccessibilitySize {
      Image(name).resizable().scaledToFit().frame(height: Self.artworkHeight)
        .offset(y: -Self.artworkRise).padding(.trailing, OkouSpace.xxxl)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
  }

  @ViewBuilder private func cardView(_ card: ForYouCard) -> some View {
    switch card.content {
    case .suggestion(let suggestion):
      ForYouSuggestionView(
        suggestion: suggestion,
        artworkInset: typeSize.isAccessibilitySize ? 0 : Self.artworkWidth,
        openSource: { id in run { if await store.open(id) { showChat() } } },
        choose: { option in run { if await store.choose(card, option: option) { showChat() } } })
    case .automation(let event):
      ForYouAutomationView(
        event: event,
        enable: { run { await store.resolve(card, event: event, enable: true) } },
        dismiss: { run { await store.resolve(card, event: event, enable: false) } })
    case .unsupported: EmptyView()
    }
  }

  private var caughtUp: some View {
    VStack(spacing: OkouSpace.md) {
      Image("ForYouRest").resizable().scaledToFit().frame(height: 104).accessibilityHidden(true)
      Text("All caught up").font(.okou(.title3).weight(.semibold))
        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("for-you-empty")
      Text("Okou will bring the next thing here when there is something worth your time.")
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        .multilineTextAlignment(.center)
      if !store.handled.isEmpty { recap }
      Button("Back to chats") { dismiss() }
        .buttonStyle(OkouButtonStyle(isPrimary: false))
        .padding(.top, OkouSpace.xs)
        .accessibilityIdentifier("for-you-done")
    }
    .frame(maxWidth: .infinity)
    .disabled(store.busy)
  }

  /// What this visit settled: a sent direction leads to its chat, a dismissal can come back.
  private var recap: some View {
    VStack(alignment: .leading, spacing: 0) {
      OkouListDivider()
      Text("Handled just now").font(.okou(.footnote).weight(.semibold))
        .foregroundStyle(OkouColor.mutedForeground).padding(.top, OkouSpace.md)
      ForEach(store.handled) { item in
        HStack(spacing: OkouSpace.ten) {
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(verbatim: item.title).font(.okou(.subheadline)).lineLimit(1)
            Text(verbatim: item.detail).font(.okou(.caption))
              .foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          if let undo = item.undo {
            Button("Undo") { run { await store.undo(undo) } }
              .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true)).fixedSize()
          } else if let id = item.threadID {
            Button("Open chat") { run { if await store.open(id) { showChat() } } }
              .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true)).fixedSize()
          }
        }
        .frame(minHeight: OkouControl.groupedRow)
      }
    }
  }

  // MARK: Dock

  /// Below a suggestion, where a chat keeps its composer: the member's own direction, and the
  /// one way to turn the suggestion down. The pill grows into the input in place, as the
  /// web's does, and folds back into it.
  @ViewBuilder private var dock: some View {
    if let card = store.current, case .suggestion(let suggestion) = card.content {
      GlassEffectContainer(spacing: OkouSpace.sm) {
        if let direction = store.direction, direction.cardID == card.id {
          ForYouDirectionComposer(
            direction: direction, card: card, suggestion: suggestion, workspace: workspace
          )
          .glassEffectID(ForYouDockGlass.input, in: dockGlass)
          .transition(.opacity)
          .accessibilityAction(.escape, collapseDirection)
        } else {
          restingDock(card)
            .transition(.opacity)
        }
      }
      .animation(
        reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86), value: isComposing
      )
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg).padding(.bottom, OkouSpace.sm)
      .disabled(store.busy)
    }
  }

  private func restingDock(_ card: ForYouCard) -> some View {
    HStack(spacing: OkouSpace.sm) {
      Button {
        run { await store.openDirection(card) }
      } label: {
        Text("What do you have in mind?")
          .font(.okou(.body)).foregroundStyle(OkouColor.placeholder).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouGlassControl(shape: .capsule))
          .glassEffectID(ForYouDockGlass.input, in: dockGlass)
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
          .modifier(OkouGlassControl(shape: .capsule))
          .glassEffectID(ForYouDockGlass.dismiss, in: dockGlass)
      }
      .menuOrder(.fixed)
      .accessibilityIdentifier("for-you-dismiss")
    }
    .buttonStyle(.plain)
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
  }

  private func collapseDirection() {
    guard let direction = store.direction else { return }
    if direction.composer.hasContent {
      direction.composer.editor.dismissKeyboard()
    } else {
      store.closeDirection()
    }
  }

  private func clearNotice() { store.notice = nil }

  private func show(_ index: Int) {
    guard store.cards.indices.contains(index) else { return }
    withAnimation(reduceMotion ? nil : .smooth) { pageID = store.cards[index].id }
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
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

/// The dock's glass shapes, which morph into one another as the input opens and closes.
private enum ForYouDockGlass: Hashable, Sendable {
  case input
  case dismiss
}
