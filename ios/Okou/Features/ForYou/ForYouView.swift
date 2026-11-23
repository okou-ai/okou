import ChatData
import SwiftUI

struct ForYouView: View {
  let store: ForYouStore
  let showChat: () -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var presentedSheet: Sheet?
  @State private var action: Task<Void, Never>?
  private enum Sheet: Identifiable {
    case feedback(ForYouCard)
    case direction(ForYouCard)
    var id: String {
      switch self {
      case .feedback(let card): "feedback-" + card.id
      case .direction(let card): "direction-" + card.id
      }
    }
  }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .top) {
        OkouColor.background.ignoresSafeArea()
        ScrollView {
          VStack(spacing: OkouSpace.lg) {
            header(width: geometry.size.width)
            if let card = store.current {
              VStack(spacing: OkouSpace.md) {
                cardView(card)
                  .padding(OkouSpace.lg)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .background(OkouColor.card, in: RoundedRectangle(cornerRadius: OkouRadius.card))
                  .overlay {
                    RoundedRectangle(cornerRadius: OkouRadius.card).strokeBorder(OkouColor.border)
                  }
                  .background(alignment: .bottom) {
                    if store.position + 1 < store.cards.count {
                      RoundedRectangle(cornerRadius: OkouRadius.card)
                        .fill(OkouColor.controlSurface)
                        .overlay {
                          RoundedRectangle(cornerRadius: OkouRadius.card).strokeBorder(
                            OkouColor.border)
                        }
                        .padding(.horizontal, OkouSpace.sm).offset(y: OkouSpace.xs)
                    }
                  }
                  .simultaneousGesture(
                    DragGesture(minimumDistance: 30).onEnded { drag in
                      let delta = drag.translation
                      guard abs(delta.width) > 60, abs(delta.width) > abs(delta.height) * 2 else {
                        return
                      }
                      withAnimation(reduceMotion ? nil : .default) {
                        store.move(delta.width < 0 ? 1 : -1)
                      }
                    }
                  )
                  .accessibilityIdentifier("for-you-card")
                if store.cards.count > 1 { pager }
              }
              .frame(maxWidth: OkouControl.readableWidth)
              .padding(.horizontal, OkouSpace.lg)
              .offset(y: -OkouSpace.xxxl)
            } else if let error = store.error {
              VStack(spacing: OkouSpace.md) {
                Text(error).foregroundStyle(OkouColor.mutedForeground)
                Button("Try again") { run { await store.load() } }
              }.padding(OkouSpace.xxl)
            } else if store.loaded {
              VStack(spacing: OkouSpace.lg) {
                Image("ForYouRest").resizable().scaledToFit().frame(height: 104)
                  .accessibilityHidden(true)
                Text("No new suggestions").font(.okou(.title3).weight(.semibold))
              }.padding(.top, OkouSpace.hero).accessibilityIdentifier("for-you-empty")
            } else {
              ProgressView().padding(.top, OkouSpace.hero)
            }
          }.padding(.bottom, OkouSpace.lg)
        }
        .refreshable { await store.load() }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { status }
    .task { await store.load() }
    .task(id: readingID) { if let id = readingID { await store.read(id) } }
    .sheet(item: $presentedSheet) { item in
      switch item {
      case .feedback(let card):
        ForYouFeedbackSheet { reason in
          closeSheet()
          run { await store.respond(card, reason: reason) }
        }
      case .direction(let card):
        ForYouDirectionSheet(card: card, store: store, close: closeSheet)
      }
    }
    .interactiveDismissDisabled(store.busy)
    .onDisappear { action?.cancel() }
  }

  private var readingID: String? {
    phase == .active && presentedSheet == nil ? store.current?.id : nil
  }

  private func header(width: CGFloat) -> some View {
    HStack {
      Button {
        dismiss()
      } label: {
        OkouIcon("chevron-left").frame(
          width: OkouControl.minimumTarget, height: OkouControl.minimumTarget
        )
        .background(.regularMaterial, in: Circle())
      }
      .accessibilityLabel("Back").accessibilityIdentifier("for-you-back").disabled(store.busy)
      Text("For you").font(.okou(.title).weight(.bold))
      Spacer()
      if store.current != nil {
        Text(verbatim: "\(store.position + 1) / \(store.cards.count)")
          .font(.okou(.subheadline).weight(.semibold)).monospacedDigit()
          .padding(.horizontal, OkouSpace.md).padding(.vertical, OkouSpace.six)
          .background(.regularMaterial, in: Capsule())
      }
    }
    .foregroundStyle(OkouColor.brandCharcoal)
    .padding(.horizontal, OkouSpace.lg)
    .padding(.top, OkouSpace.ten)
    .frame(width: width, height: 144, alignment: .top)
    .background {
      Image("ForYouCover").resizable().scaledToFill().frame(width: width, height: 144).clipped()
        .accessibilityHidden(true)
    }
  }

  @ViewBuilder private func cardView(_ card: ForYouCard) -> some View {
    switch card.content {
    case .suggestion(let suggestion):
      ForYouSuggestionView(
        suggestion: suggestion,
        artwork: ["ForYouReader", "ForYouBridge", "ForYouWay"][store.position % 3],
        openSource: { id in run { if await store.open(id) { showChat() } } },
        choose: { option in run { if await store.choose(card, option: option) { showChat() } } },
        direction: { showDirection(card) }, feedback: { showFeedback(card) },
        ignore: { run { await store.respond(card, reason: nil) } }
      ).disabled(store.busy)
    case .automation(let event):
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Label("Automation paused", okouSymbol: "workflow").font(.okou(.subheadline))
        Text(event.automationName).font(.okou(.title2).weight(.bold))
        if let description = event.automationDescription { Text(description).font(.okou(.body)) }
        Text("Paused after \(event.consecutiveFailures) consecutive failures.").font(
          .okou(.footnote))
        Button("Re-enable automation") {
          run { await store.resolve(card, event: event, enable: true) }
        }
        .buttonStyle(.borderedProminent)
        Button("Dismiss") { run { await store.resolve(card, event: event, enable: false) } }
      }.disabled(store.busy)
    case .unsupported: EmptyView()
    }
  }

  private var pager: some View {
    HStack(spacing: OkouSpace.md) {
      pageButton("chevron-left", label: "Previous card", offset: -1)
      HStack(spacing: OkouSpace.xs) {
        ForEach(store.cards.indices, id: \.self) { index in
          Capsule().fill(index == store.position ? OkouColor.foreground : OkouColor.controlBorder)
            .frame(
              width: index == store.position ? OkouSpace.lg : OkouSpace.six, height: OkouSpace.six)
        }
      }.accessibilityHidden(true)
      pageButton("chevron-right", label: "Next card", offset: 1)
    }
    .accessibilityElement(children: .contain)
  }

  private func pageButton(_ icon: String, label: LocalizedStringKey, offset: Int) -> some View {
    Button {
      withAnimation(reduceMotion ? nil : .default) { store.move(offset) }
    } label: {
      OkouIcon(icon).frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
    }.accessibilityLabel(label).disabled(
      store.busy || !store.cards.indices.contains(store.position + offset))
  }

  @ViewBuilder private var status: some View {
    if let error = store.error, store.current != nil, presentedSheet == nil {
      Text(error).font(.okou(.footnote)).frame(maxWidth: .infinity)
        .padding(OkouSpace.md).background(.regularMaterial)
    } else if let notice = store.notice {
      HStack {
        Text(notice.text).font(.okou(.subheadline))
        Spacer()
        if let undo = notice.undo {
          Button("Undo") { run { await store.undo(undo) } }.accessibilityIdentifier("for-you-undo")
        } else if let id = notice.threadID {
          Button("View chat") { run { if await store.open(id) { showChat() } } }
        }
        Button {
          store.notice = nil
        } label: {
          OkouIcon("x")
        }.accessibilityLabel("Close")
      }.padding(OkouSpace.lg).background(.regularMaterial).disabled(store.busy)
    }
  }

  private func showFeedback(_ card: ForYouCard) { presentedSheet = .feedback(card) }
  private func showDirection(_ card: ForYouCard) { presentedSheet = .direction(card) }
  private func closeSheet() { presentedSheet = nil }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
  }
}
