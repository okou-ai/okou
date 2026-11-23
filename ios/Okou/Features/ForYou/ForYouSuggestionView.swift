import ChatData
import SwiftUI

struct ForYouSuggestionView: View {
  let suggestion: ForYouSuggestion
  let artwork: String
  let openSource: (String) -> Void
  let choose: (ForYouOption) -> Void
  let direction: () -> Void
  let feedback: () -> Void
  let ignore: () -> Void

  private var source: (id: String, title: String)? {
    let drafts = suggestion.options.map(\.draft) + [suggestion.customOption.draft]
    for draft in drafts {
      for part in draft.draftUserMessage?.parts ?? [] where part["type"]?.string == "chat_thread" {
        if let id = part["threadId"]?.string, let title = part["titleSnapshot"]?.string {
          return (id, title)
        }
      }
    }
    return (suggestion.customOption.threadId ?? suggestion.options.compactMap(\.threadId).first)
      .map { ($0, String(localized: "Source chat")) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      HStack(alignment: .top, spacing: OkouSpace.sm) {
        VStack(alignment: .leading, spacing: OkouSpace.sm) {
          if let source {
            Button {
              openSource(source.id)
            } label: {
              HStack(spacing: OkouSpace.xs) {
                OkouIcon("message-circle", size: OkouIconSize.inline)
                Text(source.title).lineLimit(2)
                OkouIcon("chevron-right", size: OkouIconSize.inline)
              }.font(.okou(.footnote))
            }.buttonStyle(.plain).foregroundStyle(OkouColor.mutedForeground)
          }
          Text(suggestion.title).font(.okou(.title2).weight(.bold))
            .accessibilityAddTraits(.isHeader).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
        Image(artwork).resizable().scaledToFit().frame(width: 72, height: 72).accessibilityHidden(
          true)
      }
      if !suggestion.rationale.isEmpty {
        Text(suggestion.rationale).font(.okou(.subheadline)).foregroundStyle(
          OkouColor.mutedForeground)
      }
      VStack(spacing: OkouSpace.sm) {
        ForEach(suggestion.options) { option in
          Button {
            choose(option)
          } label: {
            HStack(alignment: .center, spacing: OkouSpace.md) {
              VStack(alignment: .leading, spacing: OkouSpace.xs) {
                Text(option.label).font(.okou(.headline))
                if !option.description.isEmpty {
                  Text(option.description).font(.okou(.footnote)).foregroundStyle(
                    OkouColor.mutedForeground)
                }
                Text(option.threadId == nil ? "Send in a new chat" : "Edit draft in original chat")
                  .font(.okou(.caption)).foregroundStyle(OkouColor.trailingValue)
              }.frame(maxWidth: .infinity, alignment: .leading)
              OkouIcon(option.threadId == nil ? "send" : "pencil", size: OkouIconSize.standard)
            }
            .padding(OkouSpace.md).frame(maxWidth: .infinity, alignment: .leading)
            .background(
              OkouColor.controlSurface, in: RoundedRectangle(cornerRadius: OkouRadius.control)
            )
            .contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("for-you-option-\(option.id)")
        }
      }
      Button(action: direction) {
        Label("Give your own direction", okouSymbol: "pencil")
          .font(.okou(.subheadline).weight(.medium)).frame(
            maxWidth: .infinity, minHeight: OkouControl.minimumTarget
          )
          .overlay {
            RoundedRectangle(cornerRadius: OkouRadius.control).strokeBorder(OkouColor.border)
          }
      }.buttonStyle(.plain).accessibilityIdentifier("for-you-direction")
      Divider()
      HStack {
        Button("Feedback", okouSymbol: "sliders-horizontal", action: feedback)
          .accessibilityIdentifier("for-you-feedback")
        Spacer()
        Button("Dismiss", okouSymbol: "x", action: ignore)
          .accessibilityIdentifier("for-you-dismiss")
      }.buttonStyle(.plain).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        .frame(minHeight: OkouControl.minimumTarget)
    }.foregroundStyle(OkouColor.foreground)
  }
}

struct ForYouFeedbackSheet: View {
  let submit: (ForYouFeedback) -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        ForEach(ForYouFeedback.allCases, id: \.self) { reason in
          Button {
            submit(reason)
          } label: {
            Label(reason.label, okouSymbol: reason.icon)
              .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
          }.buttonStyle(.plain).accessibilityIdentifier("for-you-feedback-\(reason.rawValue)")
        }
      }.navigationTitle("Feedback").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        }
    }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
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
}
