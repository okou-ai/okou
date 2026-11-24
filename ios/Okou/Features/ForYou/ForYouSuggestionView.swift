import ChatData
import SwiftUI

/// One suggestion: where it came from, what it proposes, and each direction with what
/// choosing it does. Dismissing it and writing a direction of one's own live in the page's dock.
struct ForYouSuggestionView: View {
  let suggestion: ForYouSuggestion
  /// Room the card is given to match the deck's height: it lies between the heading and the
  /// directions, so the directions stay at the bottom, by the dock.
  var extra: CGFloat = 0
  /// The direction whose choice is under way, which shows its progress in place of its arrow.
  var pendingOptionID: String?
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
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        if let source {
          Button {
            openSource(source.id)
          } label: {
            HStack(spacing: OkouSpace.six) {
              OkouIcon("message-circle", size: OkouIconSize.inline)
              Text(source.title).lineLimit(1)
              OkouIcon("chevron-right", size: OkouIconSize.accessory)
                .foregroundStyle(OkouColor.quietMark)
            }
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .padding(.horizontal, OkouSpace.ten)
            .frame(minHeight: OkouControl.inlineActionHeight)
          }
          .buttonStyle(ForYouChipButtonStyle()).accessibilityHint("View source")
          .padding(.bottom, OkouSpace.xs)
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
      .padding(.top, extra)
    }
    .foregroundStyle(OkouColor.foreground)
  }

  /// A direction says what choosing it does before it is chosen: one that sends carries the
  /// composer's amber send mark, one that only prepares a draft leads on to its chat. Each is a
  /// raised button on the card, as the web draws its options, and the one being chosen turns its
  /// mark into progress until the choice settles.
  private func optionButton(_ option: ForYouOption) -> some View {
    let sends = option.threadId == nil
    let isPending = pendingOptionID == option.id
    return Button {
      choose(option)
    } label: {
      HStack(spacing: OkouSpace.md) {
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text(option.label).font(.okou(.subheadline).weight(.medium))
          if !option.description.isEmpty {
            Text(option.description).font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
          }
          HStack(spacing: OkouSpace.xs) {
            OkouIcon(sends ? "send" : "square-pen", size: OkouIconSize.badge)
            Text(outcome(of: option)).lineLimit(1)
          }
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          .padding(.top, OkouSpace.six)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        ForYouOptionMark(sends: sends, isPending: isPending)
      }
      .multilineTextAlignment(.leading)
      .padding(.leading, OkouSpace.lg).padding(.trailing, OkouSpace.md)
      .padding(.vertical, OkouSpace.md)
      .frame(minHeight: OkouControl.minimumTarget)
    }
    .buttonStyle(ForYouOptionButtonStyle(isPending: isPending))
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
  /// Room the card is given to match the deck's height, above its actions.
  var extra: CGFloat = 0
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
        .padding(.horizontal, OkouSpace.ten)
        .frame(minHeight: OkouControl.inlineActionHeight)
        .background(
          OkouColor.stateHover,
          in: RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous))
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
      .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
      .modifier(OkouSurfaceStyle(radius: OkouRadius.control))
      // When it stopped and what happens next, as one quiet note under the automation.
      if event.recoveryScheduled || pausedOn != nil {
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          if event.recoveryScheduled {
            Text("An automatic recovery attempt was scheduled.")
          }
          if let pausedOn {
            Text("Paused on \(pausedOn)")
          }
        }
        .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
      // A card's actions are compact, side by side; Enable is its one commitment. They stay at
      // the card's bottom when it is given room to match the deck.
      HStack(spacing: OkouSpace.sm) {
        Button("Enable", action: enable)
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
          .accessibilityIdentifier("for-you-enable")
        Button("Dismiss", action: dismiss)
          .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
          .accessibilityIdentifier("for-you-event-dismiss")
      }
      .padding(.top, OkouSpace.xs + extra)
    }
    .foregroundStyle(OkouColor.foreground)
  }
}

/// The mark at a direction's trailing edge: the composer's amber send for one that sends now, a
/// quiet arrow for one that opens a draft, and progress while the choice is under way.
private struct ForYouOptionMark: View {
  let sends: Bool
  let isPending: Bool

  var body: some View {
    ZStack {
      if isPending {
        ProgressView().controlSize(.small)
          .tint(sends ? OkouColor.primaryForeground : OkouColor.mutedForeground)
      } else {
        OkouIcon(sends ? "arrow-up" : "arrow-right", size: OkouIconSize.inline)
      }
    }
    .transition(.opacity)
    .foregroundStyle(sends ? OkouColor.primaryForeground : OkouColor.foreground)
    .frame(width: OkouControl.addControl, height: OkouControl.addControl)
    .background(sends ? OkouColor.primary : OkouColor.stateHover, in: Circle())
    .animation(OkouMotion.press, value: isPending)
    .accessibilityHidden(true)
  }
}

/// A direction's raised button, as the web draws its options: the card's fill with a hairline,
/// darkened by the pressed state layer and eased in a little under the finger. While another
/// choice is under way it fades as any disabled control does; the one being chosen stays whole.
private struct ForYouOptionButtonStyle: ButtonStyle {
  let isPending: Bool
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private static let pressedScale: CGFloat = 0.98

  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous)
    let pressed = configuration.isPressed
    configuration.label
      .background(OkouColor.card, in: shape)
      .overlay {
        shape.fill(pressed ? OkouColor.statePressed : .clear).allowsHitTesting(false)
      }
      .overlay {
        shape.strokeBorder(
          pressed ? OkouColor.controlBorder : OkouColor.border, lineWidth: OkouSpace.hairline
        )
        .allowsHitTesting(false)
      }
      .contentShape(shape)
      .scaleEffect(pressed && !reduceMotion ? Self.pressedScale : 1)
      .opacity(isEnabled || isPending ? 1 : 0.5)
      .animation(reduceMotion ? nil : OkouMotion.press, value: pressed)
  }
}

/// The quiet chip that opens a suggestion's source chat: the neutral state layer on the card,
/// deepening while pressed.
private struct ForYouChipButtonStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        configuration.isPressed ? OkouColor.statePressed : OkouColor.stateHover,
        in: RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
      )
      .contentShape(Rectangle())
      .animation(reduceMotion ? nil : OkouMotion.press, value: configuration.isPressed)
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
