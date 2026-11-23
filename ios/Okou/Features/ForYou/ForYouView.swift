import ChatData
import SwiftUI

struct ForYouView: View {
  let workspace: WorkspaceStore
  let showChat: () -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var action: Task<Void, Never>?
  private var store: ForYouStore { workspace.forYou }

  var body: some View {
    ScrollViewReader { scroll in
      ScrollView {
        VStack(spacing: 0) {
          header
          if let card = store.current {
            VStack(spacing: OkouSpace.lg) {
              cardView(card).padding(OkouSpace.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(OkouColor.card, in: RoundedRectangle(cornerRadius: OkouRadius.card))
                .overlay {
                  RoundedRectangle(cornerRadius: OkouRadius.card).strokeBorder(OkouColor.border)
                }
                .background(alignment: .bottom) {
                  if store.cards.count > 1 {
                    RoundedRectangle(cornerRadius: OkouRadius.card).fill(OkouColor.controlSurface)
                      .overlay {
                        RoundedRectangle(cornerRadius: OkouRadius.card).strokeBorder(
                          OkouColor.border)
                      }
                      .padding(.horizontal, OkouSpace.sm).offset(y: OkouSpace.six)
                  }
                }
              if store.cards.count > 1 { pager }
            }
            .frame(maxWidth: OkouControl.readableWidth)
            .padding(.horizontal, OkouSpace.lg).padding(.top, -OkouSpace.xxl)
          } else if let error = store.error {
            VStack(spacing: OkouSpace.md) {
              Text(error).foregroundStyle(OkouColor.mutedForeground)
              Button("Try again") { run { await store.load() } }
            }.padding(OkouSpace.xxl)
          } else if store.loaded {
            VStack(spacing: OkouSpace.md) {
              Image("ForYouRest").resizable().scaledToFit().frame(height: 104).accessibilityHidden(
                true)
              Text("All caught up").font(.okou(.title3).weight(.semibold))
                .accessibilityIdentifier("for-you-empty")
              Text("Okou will bring the next thing here when there is something worth your time.")
                .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
                .multilineTextAlignment(.center)
            }.padding(.horizontal, OkouSpace.xxxl).padding(.top, OkouSpace.hero)
          } else {
            ProgressView().padding(.top, OkouSpace.hero)
          }
        }.padding(.bottom, OkouSpace.lg)
      }
      .scrollDismissesKeyboard(.interactively)
      .refreshable { await store.load() }
      .onChange(of: store.direction?.cardID) { _, id in
        if let id { scroll.scrollTo("direction-" + id, anchor: .center) }
      }
    }
    .background(OkouColor.background)
    .safeAreaInset(edge: .bottom, spacing: 0) { status }
    .composerSuggestionOverlay()
    .task { await store.load() }
    .task(id: readingID) { if let id = readingID { await store.read(id) } }
    .interactiveDismissDisabled(store.busy)
    .onDisappear {
      action?.cancel()
      store.closeDirection()
    }
  }

  private var readingID: String? { phase == .active ? store.current?.id : nil }

  private var header: some View {
    VStack(spacing: 0) {
      HStack(spacing: OkouSpace.sm) {
        Button {
          dismiss()
        } label: {
          OkouIcon("chevron-left").frame(
            width: OkouControl.minimumTarget, height: OkouControl.minimumTarget
          )
          .background(.regularMaterial, in: Circle())
        }.accessibilityLabel("Back").accessibilityIdentifier("for-you-back").disabled(store.busy)
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text("For you").font(.okou(.title2).weight(.semibold))
          Text("Okou’s picks to handle").font(.okou(.caption))
        }.frame(maxWidth: .infinity, alignment: .leading)
        if store.current != nil {
          Text(verbatim: "\(store.position + 1) / \(store.cards.count)")
            .font(.okou(.footnote).weight(.medium)).monospacedDigit()
        }
      }
      if store.cards.count > 1 {
        let start = max(0, min(store.position - 2, store.cards.count - 5))
        HStack(spacing: OkouSpace.xs) {
          ForEach(start..<min(start + 5, store.cards.count), id: \.self) { index in
            Button {
              browse(index - store.position)
            } label: {
              Capsule().fill(OkouColor.brandCharcoal.opacity(store.position == index ? 0.85 : 0.24))
                .frame(height: OkouSpace.xs).frame(
                  maxWidth: .infinity, minHeight: OkouControl.minimumTarget
                )
                .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel(
              "Show suggestion \(index + 1) of \(store.cards.count)"
            )
            .accessibilityAddTraits(index == store.position ? .isSelected : [])
          }
        }.disabled(store.busy)
      }
    }
    .foregroundStyle(OkouColor.brandCharcoal)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
    .frame(maxWidth: .infinity, minHeight: 154, alignment: .top)
    .background {
      GeometryReader { geometry in
        Image("ForYouCover").resizable().scaledToFill()
          .frame(width: geometry.size.width, height: geometry.size.height).clipped()
          .accessibilityHidden(true)
      }
    }
  }

  @ViewBuilder private func cardView(_ card: ForYouCard) -> some View {
    switch card.content {
    case .suggestion(let suggestion):
      ForYouSuggestionView(
        suggestion: suggestion, artwork: store.illustration(for: card),
        openSource: { id in run { if await store.open(id) { showChat() } } },
        choose: { option in run { if await store.choose(card, option: option) { showChat() } } },
        respond: { reason in run { await store.respond(card, reason: reason) } }, browse: browse
      ) {
        if let direction = store.direction, direction.cardID == card.id {
          ForYouDirectionComposer(
            direction: direction, card: card, suggestion: suggestion, workspace: workspace
          )
          .id("direction-" + card.id)
        } else {
          Button {
            run { await store.openDirection(card) }
          } label: {
            HStack(spacing: OkouSpace.md) {
              Text("What do you have in mind?").frame(maxWidth: .infinity, alignment: .leading)
              OkouIcon("square-pen", size: OkouIconSize.standard)
            }.font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
              .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
              .frame(minHeight: OkouControl.minimumTarget)
              .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: OkouRadius.card))
          }.buttonStyle(.plain).accessibilityHint(
            "Ask a question or describe what you’d like to do."
          )
          .accessibilityIdentifier("for-you-direction")
        }
      }.disabled(store.busy)
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
    HStack(spacing: OkouSpace.sm) {
      Spacer()
      pageButton("chevron-left", label: "Previous suggestion", offset: -1)
      pageButton("chevron-right", label: "Next suggestion", offset: 1)
    }
  }

  private func pageButton(_ icon: String, label: LocalizedStringKey, offset: Int) -> some View {
    Button {
      browse(offset)
    } label: {
      OkouIcon(icon).frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .background(OkouColor.card, in: Circle()).overlay {
          Circle().strokeBorder(OkouColor.border)
        }
    }.buttonStyle(.plain).accessibilityLabel(label).disabled(store.busy)
  }

  private func browse(_ offset: Int) {
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { store.move(offset) }
  }

  @ViewBuilder private var status: some View {
    if let error = store.error, store.current != nil {
      Text(error).font(.okou(.footnote)).frame(maxWidth: .infinity)
        .padding(OkouSpace.md).background(.regularMaterial)
    } else if let notice = store.notice {
      HStack {
        Text(notice.text).font(.okou(.subheadline))
        Spacer()
        if let undo = notice.undo {
          Button("Undo") { run { await store.undo(undo) } }.accessibilityIdentifier("for-you-undo")
        } else if let id = notice.threadID {
          Button("Open chat") { run { if await store.open(id) { showChat() } } }
        }
        Button {
          store.notice = nil
        } label: {
          OkouIcon("x")
        }.accessibilityLabel("Close")
      }.padding(OkouSpace.lg).background(.regularMaterial).disabled(store.busy)
    }
  }

  private func run(_ operation: @escaping @MainActor () async -> Void) {
    guard !store.busy else { return }
    action = Task { await operation() }
  }
}
