import ChatData
import SwiftUI

/// The cover fills whatever the card leaves, so the card, its directions and the dock stay
/// in reach at the bottom, as a chat's latest turn and its composer do.
struct ForYouView: View {
  let workspace: WorkspaceStore
  let showChat: () -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var action: Task<Void, Never>?
  /// The card's top edge on screen: the cover ends just behind it.
  @State private var cardTop: CGFloat = 360
  private var store: ForYouStore { workspace.forYou }

  /// The artwork rests on the card's top edge, mostly above it.
  private static let artworkHeight: CGFloat = 72
  private static let artworkRise: CGFloat = 58
  private static let artworkWidth: CGFloat = 96

  var body: some View {
    VStack(spacing: 0) {
      GeometryReader { viewport in
        ScrollView {
          VStack(spacing: 0) {
            header
            notices
            Spacer(minLength: Self.artworkRise + OkouSpace.sm)
            content
          }
          .frame(maxWidth: .infinity, minHeight: viewport.size.height)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.load() }
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
    .interactiveDismissDisabled(store.busy)
    .onDisappear {
      action?.cancel()
      store.closeDirection()
    }
  }

  private var readingID: String? { phase == .active ? store.current?.id : nil }

  private var cover: some View {
    VStack(spacing: 0) {
      GeometryReader { geometry in
        Image("ForYouCover").resizable().scaledToFill()
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
      .frame(height: max(0, cardTop + OkouSpace.section))
      Spacer(minLength: 0)
    }
    .ignoresSafeArea(edges: .top)
    .accessibilityHidden(true)
  }

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
          Text(verbatim: "\(store.position + 1) / \(store.cards.count)")
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
    let start = max(0, min(store.position - 2, store.cards.count - 5))
    return HStack(spacing: OkouSpace.xs) {
      ForEach(start..<min(start + 5, store.cards.count), id: \.self) { index in
        Button {
          browse(index - store.position)
        } label: {
          Capsule().fill(OkouColor.brandCharcoal.opacity(store.position == index ? 0.85 : 0.24))
            .frame(height: OkouSpace.xs).frame(
              maxWidth: .infinity, minHeight: OkouControl.minimumTarget
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show suggestion \(index + 1) of \(store.cards.count)")
        .accessibilityAddTraits(index == store.position ? .isSelected : [])
      }
    }
    .disabled(store.busy)
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

  @ViewBuilder private var content: some View {
    if let card = store.current {
      panel { cardView(card).disabled(store.busy) }
        .overlay(alignment: .topTrailing) { artwork(for: card) }
        .simultaneousGesture(swipe)
        .id(card.id)
    } else if let error = store.error {
      panel {
        VStack(spacing: OkouSpace.md) {
          Text(error).foregroundStyle(OkouColor.mutedForeground)
          Button("Try again") { run { await store.load() } }
        }
        .frame(maxWidth: .infinity).padding(.vertical, OkouSpace.xxl)
      }
    } else if store.loaded {
      panel { caughtUp }
    } else {
      panel { ProgressView().frame(maxWidth: .infinity).padding(.vertical, OkouSpace.hero) }
    }
  }

  /// The one surface of the page. It reports where it begins, for the cover behind it.
  private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
      .padding(OkouSpace.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .modifier(OkouSurfaceStyle(radius: OkouRadius.sheet))
      .onGeometryChange(for: CGFloat.self) {
        $0.frame(in: .global).minY
      } action: {
        cardTop = $0
      }
      .frame(maxWidth: OkouControl.readableWidth)
      .padding(.horizontal, OkouSpace.lg).padding(.bottom, OkouSpace.sm)
  }

  @ViewBuilder private func artwork(for card: ForYouCard) -> some View {
    if let name = store.illustration(for: card), !typeSize.isAccessibilitySize {
      Image(name).resizable().scaledToFit().frame(height: Self.artworkHeight)
        .offset(y: -Self.artworkRise).padding(.trailing, OkouSpace.xxxl)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
  }

  /// A sideways swipe anywhere on the card turns to the next or the previous one.
  private var swipe: some Gesture {
    DragGesture(minimumDistance: 30).onEnded { drag in
      let delta = drag.translation
      guard abs(delta.width) > 60, abs(delta.width) > abs(delta.height) * 2 else { return }
      browse(delta.width < 0 ? 1 : -1)
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

  /// Below a suggestion, where a chat keeps its composer: the member's own direction, and the
  /// one way to turn the suggestion down.
  @ViewBuilder private var dock: some View {
    if let card = store.current, case .suggestion(let suggestion) = card.content {
      Group {
        if let direction = store.direction, direction.cardID == card.id {
          VStack(alignment: .trailing, spacing: 0) {
            Button("Cancel") { store.closeDirection() }
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
              .frame(minHeight: OkouControl.inlineActionHeight)
              .buttonStyle(.plain)
            ForYouDirectionComposer(
              direction: direction, card: card, suggestion: suggestion, workspace: workspace)
          }
        } else {
          restingDock(card)
        }
      }
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
      }
      .menuOrder(.fixed)
      .accessibilityIdentifier("for-you-dismiss")
    }
    .buttonStyle(.plain)
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
  }

  private func clearNotice() { store.notice = nil }

  private func browse(_ offset: Int) {
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { store.move(offset) }
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
  }
}
