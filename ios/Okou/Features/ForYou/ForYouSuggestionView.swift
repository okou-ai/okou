import ChatData
import SwiftUI

/// One suggestion: where it came from, what it proposes, and each direction with what
/// choosing it does. Dismissing it and writing a direction of one's own live in the page's dock.
struct ForYouSuggestionView: View {
  let suggestion: ForYouSuggestion
  /// The width the artwork resting on the card's edge takes from the source line.
  let artworkInset: CGFloat
  let openSource: (String) -> Void
  let choose: (ForYouOption) -> Void

  private var source: (id: String, title: String)? {
    let target = suggestion.options.compactMap(\.threadId).first
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    let reference = references.first { $0["threadId"]?.string == target } ?? references.first
    guard let id = target ?? reference?["threadId"]?.string else { return nil }
    return (id, threadTitle(id) ?? String(localized: "View source"))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        if let source {
          Button {
            openSource(source.id)
          } label: {
            HStack(spacing: OkouSpace.six) {
              OkouIcon("message-circle", size: OkouIconSize.inline)
              Text(source.title).lineLimit(1)
              OkouIcon("chevron-right", size: OkouIconSize.badge)
            }
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .padding(.horizontal, OkouSpace.sm)
            .frame(minHeight: OkouControl.inlineActionHeight)
            .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: OkouRadius.small))
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain).accessibilityHint("View source")
          .padding(.trailing, artworkInset)
        }
        Text(suggestion.title).font(.okou(.title2).weight(.semibold))
          .accessibilityAddTraits(.isHeader).fixedSize(horizontal: false, vertical: true)
        if !suggestion.rationale.isEmpty {
          Text(suggestion.rationale).font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      VStack(spacing: OkouSpace.sm) {
        ForEach(suggestion.options) { option in
          optionButton(option)
        }
      }
    }
    .foregroundStyle(OkouColor.foreground)
  }

  /// A direction says what choosing it does before it is chosen: one that sends carries the
  /// composer's send mark, one that only prepares a draft leads on to its chat.
  private func optionButton(_ option: ForYouOption) -> some View {
    let sends = option.threadId == nil
    return Button {
      choose(option)
    } label: {
      HStack(spacing: OkouSpace.md) {
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text(option.label).font(.okou(.callout).weight(.medium))
          if !option.description.isEmpty {
            Text(option.description).font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
          }
          HStack(spacing: OkouSpace.xs) {
            OkouIcon(sends ? "send" : "square-pen", size: OkouIconSize.badge)
            Text(outcome(of: option)).lineLimit(1)
          }
          .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          .padding(.top, OkouSpace.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        OkouIcon(sends ? "arrow-up" : "arrow-right", size: OkouIconSize.inline)
          .foregroundStyle(sends ? OkouColor.background : OkouColor.foreground)
          .frame(width: OkouControl.addControl, height: OkouControl.addControl)
          .background(sends ? OkouColor.foreground : OkouColor.card, in: Circle())
          .overlay { Circle().strokeBorder(sends ? Color.clear : OkouColor.border) }
          .accessibilityHidden(true)
      }
      .multilineTextAlignment(.leading)
      .padding(.leading, OkouSpace.lg).padding(.trailing, OkouSpace.md)
      .padding(.vertical, OkouSpace.md)
      .frame(minHeight: OkouControl.minimumTarget)
      .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: OkouRadius.chat))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint(
      sends ? Text("Send to a new chat") : Text("Prepare a draft in the existing chat")
    )
    .accessibilityIdentifier("for-you-option-\(option.id)")
  }

  private func outcome(of option: ForYouOption) -> String {
    guard let id = option.threadId else { return String(localized: "Sends now · new chat") }
    guard let title = threadTitle(id), !title.isEmpty else {
      return String(localized: "Prepare a draft in the existing chat")
    }
    return String(localized: "Opens a draft in “\(title)”")
  }

  private func threadTitle(_ id: String) -> String? {
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    return references.first { $0["threadId"]?.string == id }?["titleSnapshot"]?.string
  }
}

/// A paused automation: why it stopped, which one it is, and the two ways to settle it.
struct ForYouAutomationView: View {
  let event: ForYouAutomation
  let enable: () -> Void
  let dismiss: () -> Void

  private var pausedOn: String? {
    guard let stamp = event.disabledAt else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = fractional.date(from: stamp) ?? ISO8601DateFormatter().date(from: stamp)
    return date?.formatted(date: .abbreviated, time: .shortened)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      Label("System update", okouSymbol: "workflow", iconSize: OkouIconSize.inline)
        .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        .padding(.horizontal, OkouSpace.sm)
        .frame(minHeight: OkouControl.inlineActionHeight)
        .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: OkouRadius.small))
      Text("Automation paused").font(.okou(.title2).weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text(
        """
        We paused this automation after \(event.consecutiveFailures) consecutive run attempts \
        didn’t complete successfully. This gives you time to review what happened before it \
        runs again.
        """
      )
      .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
      .fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        Text(verbatim: event.automationName).font(.okou(.subheadline).weight(.medium))
        if let description = event.automationDescription, !description.isEmpty {
          Text(verbatim: description).font(.okou(.footnote))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(OkouSpace.md)
      .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: OkouRadius.chat))
      if event.recoveryScheduled {
        Text("An automatic recovery attempt was scheduled.").font(.okou(.footnote))
          .foregroundStyle(OkouColor.mutedForeground)
      }
      if let pausedOn {
        Text("Paused on \(pausedOn)").font(.okou(.caption))
          .foregroundStyle(OkouColor.mutedForeground)
      }
      HStack(spacing: OkouSpace.sm) {
        Button("Enable", action: enable)
          .buttonStyle(OkouButtonStyle(isPrimary: true))
          .accessibilityIdentifier("for-you-enable")
        Button("Dismiss", action: dismiss)
          .buttonStyle(OkouButtonStyle(isPrimary: false))
          .fixedSize(horizontal: true, vertical: false)
          .accessibilityIdentifier("for-you-event-dismiss")
      }
    }
    .foregroundStyle(OkouColor.foreground)
  }
}

extension ForYouFeedback {
  var title: String {
    switch self {
    case .alreadyDone: String(localized: "Already done")
    case .notPlanned: String(localized: "Not planned")
    case .dontNudge: String(localized: "Don’t nudge me")
    case .lessLikeThis: String(localized: "Less like this")
    }
  }

  var icon: String {
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
