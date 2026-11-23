import ChatData
import SwiftUI

struct ForYouSuggestionView<Direction: View>: View {
  let suggestion: ForYouSuggestion
  let artwork: String?
  let openSource: (String) -> Void
  let choose: (ForYouOption) -> Void
  let respond: (ForYouFeedback?) -> Void
  let browse: (Int) -> Void
  @ViewBuilder let direction: () -> Direction
  @Environment(\.dynamicTypeSize) private var typeSize

  private var source: (id: String, title: String)? {
    let target = suggestion.options.compactMap(\.threadId).first
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    let reference = references.first { $0["threadId"]?.string == target } ?? references.first
    guard let id = target ?? reference?["threadId"]?.string else { return nil }
    let title = reference?["threadId"]?.string == id ? reference?["titleSnapshot"]?.string : nil
    return (id, title ?? String(localized: "View source"))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      HStack(alignment: .top, spacing: OkouSpace.sm) {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          if let source {
            Button {
              openSource(source.id)
            } label: {
              Text(source.title).underline().lineLimit(2).font(.okou(.footnote))
            }.buttonStyle(.plain).foregroundStyle(OkouColor.mutedForeground)
              .accessibilityHint("View source")
          }
          Text(suggestion.title).font(.okou(.title3).weight(.semibold))
            .accessibilityAddTraits(.isHeader).fixedSize(horizontal: false, vertical: true)
          if !suggestion.rationale.isEmpty {
            Text(suggestion.rationale).font(.okou(.subheadline))
              .foregroundStyle(OkouColor.mutedForeground)
              .fixedSize(horizontal: false, vertical: true)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .trailing, spacing: 0) {
          Button {
            respond(nil)
          } label: {
            OkouIcon("x", size: OkouIconSize.standard)
              .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
              .contentShape(Rectangle())
          }.buttonStyle(.plain).foregroundStyle(OkouColor.mutedForeground)
            .accessibilityLabel("Dismiss").accessibilityIdentifier("for-you-dismiss")
          if let artwork, !typeSize.isAccessibilitySize {
            Image(artwork).resizable().scaledToFit().frame(width: 78, height: 68)
              .accessibilityHidden(true)
          }
        }
      }
      .simultaneousGesture(
        DragGesture(minimumDistance: 30).onEnded { drag in
          let delta = drag.translation
          guard abs(delta.width) > 60, abs(delta.width) > abs(delta.height) * 2 else { return }
          browse(delta.width < 0 ? 1 : -1)
        })
      VStack(spacing: OkouSpace.sm) {
        ForEach(suggestion.options) { option in
          Button {
            choose(option)
          } label: {
            HStack(spacing: OkouSpace.md) {
              VStack(alignment: .leading, spacing: OkouSpace.xs) {
                Text(option.label).font(.okou(.subheadline).weight(.medium))
                if !option.description.isEmpty {
                  Text(option.description).font(.okou(.footnote))
                    .foregroundStyle(OkouColor.mutedForeground)
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
              OkouIcon(option.threadId == nil ? "send" : "square-pen", size: OkouIconSize.standard)
                .foregroundStyle(OkouColor.mutedForeground)
            }
            .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
            .frame(minHeight: OkouControl.minimumTarget)
            .background(OkouColor.card, in: RoundedRectangle(cornerRadius: OkouRadius.card))
            .overlay {
              RoundedRectangle(cornerRadius: OkouRadius.card).strokeBorder(OkouColor.border)
            }
            .contentShape(Rectangle())
          }.buttonStyle(.plain)
            .accessibilityHint(
              option.threadId == nil
                ? Text("Send to a new chat") : Text("Prepare a draft in the existing chat")
            )
            .accessibilityIdentifier("for-you-option-\(option.id)")
        }
        direction()
      }
      LazyVGrid(
        columns: Array(
          repeating: GridItem(.flexible(), spacing: OkouSpace.sm),
          count: typeSize.isAccessibilitySize ? 1 : 2), spacing: OkouSpace.sm
      ) {
        ForEach(ForYouFeedback.allCases, id: \.self) { reason in
          Button {
            respond(reason)
          } label: {
            HStack(spacing: OkouSpace.six) {
              OkouIcon(reason.icon, size: OkouIconSize.inline).foregroundStyle(
                OkouColor.mutedForeground)
              Text(reason.label).font(.okou(.footnote)).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, OkouSpace.sm).padding(.vertical, OkouSpace.xs)
            .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget)
            .overlay { Capsule().strokeBorder(OkouColor.border) }.contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("for-you-feedback-\(reason.rawValue)")
        }
      }
      .accessibilityElement(children: .contain).accessibilityLabel("How is this suggestion?")
    }.foregroundStyle(OkouColor.foreground)
  }
}

extension ForYouFeedback {
  fileprivate var label: LocalizedStringKey {
    switch self {
    case .alreadyDone: "Already done"
    case .notPlanned: "Not planned"
    case .dontNudge: "Don’t nudge me"
    case .lessLikeThis: "Less like this"
    }
  }

  fileprivate var icon: String {
    switch self {
    case .alreadyDone: "circle-check"
    case .notPlanned: "circle-minus"
    case .dontNudge: "bell-off"
    case .lessLikeThis: "eye-off"
    }
  }

  var confirmation: String {
    switch self {
    case .alreadyDone: String(localized: "Noted — this is already done")
    case .notPlanned: String(localized: "Noted — this is not planned")
    case .dontNudge: String(localized: "Noted — please don’t nudge me about this again")
    case .lessLikeThis: String(localized: "You’ll see fewer suggestions like this.")
    }
  }
}
