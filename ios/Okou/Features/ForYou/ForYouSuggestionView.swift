import ChatData
import SwiftUI

/// One suggestion: where it came from, what it proposes, and each direction with what
/// choosing it does. Dismissing it and writing a direction of one's own live in the page's dock.
struct ForYouSuggestionView: View {
  let suggestion: ForYouSuggestion
  /// The height the deck gives the card's content, or none to take its own (`ForYouCardLayout`).
  var height: CGFloat?
  /// Hears the card's own content height, for the deck to size itself.
  var report: ((CGFloat) -> Void)?
  /// The direction whose choice is under way, which shows its progress in place of its arrow.
  var pendingOptionID: String?
  /// While the member writes a direction of their own, the card stands above the input as its
  /// context: its title and reason only, within the height it is given. Its source steps aside
  /// with its directions, so the draft is never left behind for another chat.
  var isContext = false
  let openSource: (String) -> Void
  let choose: (ForYouOption) -> Void
  @State private var showsWholeReason = false
  @State private var wholeReasonHeight: CGFloat = 0
  @State private var shownReasonHeight: CGFloat = 0
  /// A long reason shows its first lines until it is opened, so a dense card keeps its
  /// directions in view.
  private static let reasonLines = 3
  private static let descriptionLines = 3

  private var source: (id: String, title: String)? {
    let target = suggestion.options.compactMap(\.threadId).first
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    let reference = references.first { $0["threadId"]?.string == target } ?? references.first
    guard let id = target ?? reference?["threadId"]?.string else { return nil }
    return (id, threadTitle(id) ?? String(localized: "View source"))
  }

  var body: some View {
    ForYouCardLayout(
      height: height, spacing: OkouSpace.xl, showsActions: !isContext, report: report
    ) {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        if let source, !isContext {
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
          .transition(.opacity)
        }
        Text(suggestion.title).font(.okou(.title3).weight(.semibold))
          .accessibilityAddTraits(.isHeader).fixedSize(horizontal: false, vertical: true)
        if !suggestion.rationale.isEmpty { reason }
      }
    } actions: {
      VStack(spacing: OkouSpace.sm) {
        ForEach(suggestion.options) { option in
          optionButton(option)
        }
      }
    }
    .foregroundStyle(OkouColor.foreground)
  }

  /// Why Okou suggests it: its first lines, ending in Show more when they do not hold all of it,
  /// so a long reason costs no extra row; the reason itself opens too. Once open, Show less
  /// follows it. VoiceOver always reads the whole reason.
  private var reason: some View {
    let clipped = wholeReasonHeight > shownReasonHeight + OkouSpace.one
    return VStack(alignment: .leading, spacing: 0) {
      Text(suggestion.rationale).font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
        .lineLimit(showsWholeReason ? nil : Self.reasonLines)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          shownReasonHeight = $0
        }
        // The whole reason, laid out unseen at the same width, tells whether the lines shown
        // hold all of it.
        .background(alignment: .top) {
          Text(suggestion.rationale).font(.okou(.subheadline))
            .fixedSize(horizontal: false, vertical: true)
            .hidden()
            .onGeometryChange(for: CGFloat.self) {
              $0.size.height
            } action: {
              wholeReasonHeight = $0
            }
        }
        .overlay(alignment: .bottomTrailing) {
          if clipped && !showsWholeReason {
            reasonToggle("Show more")
              // The last line fades into the card under it, so the words never collide.
              .padding(.leading, OkouSpace.hero + OkouSpace.lg)
              .background {
                LinearGradient(
                  stops: [
                    .init(color: OkouColor.card.opacity(0), location: 0),
                    .init(color: OkouColor.card, location: 0.4)
                  ], startPoint: .leading, endPoint: .trailing)
              }
          }
        }
        .contentShape(Rectangle())
        .onTapGesture {
          if clipped && !showsWholeReason { toggleReason() }
        }
      if showsWholeReason {
        reasonToggle("Show less")
          .frame(minHeight: OkouControl.inlineActionHeight)
      }
    }
  }

  private func reasonToggle(_ title: LocalizedStringKey) -> some View {
    Button(title, action: toggleReason)
      .buttonStyle(.plain)
      .font(.okou(.subheadline).weight(.semibold)).foregroundStyle(OkouColor.foreground)
      .contentShape(Rectangle().inset(by: -OkouSpace.ten))
      .accessibilityHidden(true)
  }

  private func toggleReason() {
    withAnimation(OkouMotion.transition) { showsWholeReason.toggle() }
  }

  /// A direction says what choosing it does before it is chosen: one that sends carries the
  /// composer's amber send mark, one that only prepares a draft leads on to its chat (the
  /// outcome is the mark's meaning and VoiceOver's hint). Its mark sits beside the label, so
  /// the description takes the button's full width. Each is a raised button on the card, as the
  /// web draws its options, and the one being chosen turns its mark into progress until the
  /// choice settles.
  private func optionButton(_ option: ForYouOption) -> some View {
    let sends = option.threadId == nil
    let isPending = pendingOptionID == option.id
    return Button {
      choose(option)
    } label: {
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        HStack(spacing: OkouSpace.md) {
          Text(option.label).font(.okou(.subheadline).weight(.medium))
            .frame(maxWidth: .infinity, alignment: .leading)
          ForYouOptionMark(sends: sends, isPending: isPending)
        }
        // A long description keeps its first lines so a dense card leaves its heading room;
        // VoiceOver reads all of it.
        if !option.description.isEmpty {
          Text(option.description).font(.okou(.footnote))
            .foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(Self.descriptionLines)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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

  private func threadTitle(_ id: String) -> String? {
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    return references.first { $0["threadId"]?.string == id }?["titleSnapshot"]?.string
  }
}

/// A paused automation: why it stopped, which one it is, and the two ways to settle it.
struct ForYouAutomationView: View {
  let event: ForYouAutomation
  /// The height the deck gives the card's content, or none to take its own.
  var height: CGFloat?
  /// Hears the card's own content height, for the deck to size itself.
  var report: ((CGFloat) -> Void)?
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
    ForYouCardLayout(height: height, spacing: OkouSpace.lg, report: report) {
      heading
    } actions: {
      // A card's actions are compact, side by side; Enable is its one commitment.
      HStack(spacing: OkouSpace.sm) {
        Button("Enable", action: enable)
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
          .accessibilityIdentifier("for-you-enable")
        Button("Dismiss", action: dismiss)
          .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
          .accessibilityIdentifier("for-you-event-dismiss")
      }
    }
    .foregroundStyle(OkouColor.foreground)
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      Label("System update", okouSymbol: "workflow", iconSize: OkouIconSize.inline)
        .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        .padding(.horizontal, OkouSpace.ten)
        .frame(minHeight: OkouControl.inlineActionHeight)
        .background(
          OkouColor.stateHover,
          in: RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous))
      Text("Automation paused").font(.okou(.title3).weight(.semibold))
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
    }
  }
}

/// The room between a card's edge and its content: more above the heading, where the card's
/// large corner curves. A heading that scrolls runs out to the card's edge through it.
enum ForYouCardInset {
  static let top = OkouSpace.xxl
  static let side = OkouSpace.xl
  static let bottom = OkouSpace.xl
}

/// A card's heading over its actions. Given the deck's height, the actions stay at the card's
/// bottom and the heading takes what is left, scrolling there when it is longer. A scrolling
/// heading runs from the card's top edge down to the actions, so its text comes and goes at those
/// edges rather than at the card's inset; it fades out at whichever edge more lies beyond, and
/// its scroll indicator flashes when it appears, so the reader can tell there is more. When the
/// actions would leave the heading less than a third of the card, as at the largest text sizes,
/// heading and actions scroll as one from the title. Without its actions, as while a direction is
/// written, the heading takes its own height up to the one given and runs out through the card's
/// bottom edge past it. Without a height the card takes its own. Either way it reports its own
/// height (heading, gap and actions), which never depends on the height it is given.
struct ForYouCardLayout<Heading: View, Actions: View>: View {
  let height: CGFloat?
  let spacing: CGFloat
  let showsActions: Bool
  let report: ((CGFloat) -> Void)?
  let heading: Heading
  let actions: Actions
  @State private var headingHeight: CGFloat = 0
  @State private var actionsHeight: CGFloat = 0
  @State private var hasMoreBelow = false
  @State private var hasMoreAbove = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The height over which the text fades out at an edge more lies beyond.
  private var fade: CGFloat { OkouSpace.xxxl }
  /// The least share of the card a heading keeps beside actions that stay put.
  private var headingShare: CGFloat { 1 / 3 }

  init(
    height: CGFloat?, spacing: CGFloat, showsActions: Bool = true, report: ((CGFloat) -> Void)?,
    @ViewBuilder heading: () -> Heading, @ViewBuilder actions: () -> Actions
  ) {
    self.height = height
    self.spacing = spacing
    self.showsActions = showsActions
    self.report = report
    self.heading = heading()
    self.actions = actions()
  }

  var body: some View {
    if let height {
      let pinsActions = showsActions && height - actionsHeight - spacing >= height * headingShare
      VStack(alignment: .leading, spacing: spacing) {
        scrolling(below: pinsActions ? spacing : ForYouCardInset.bottom) {
          measuredHeading
          if showsActions && !pinsActions {
            measuredActions.padding(.top, spacing).transition(.opacity)
          }
        }
        if pinsActions { measuredActions.transition(.opacity) }
      }
      .frame(height: contentRoom(within: height), alignment: .top)
    } else {
      VStack(alignment: .leading, spacing: spacing) {
        measuredHeading
        if showsActions { measuredActions.transition(.opacity) }
      }
    }
  }

  /// Scrolls its content within the card. It reaches past the content by the card's top inset
  /// above and by `below` underneath, keeping that room inside the scroll, so the text scrolls in
  /// and out at the card's edge (or at the actions) instead of stopping short of it.
  private func scrolling<Content: View>(
    below: CGFloat, @ViewBuilder _ content: () -> Content
  ) -> some View {
    let above = ForYouCardInset.top
    return ScrollView {
      VStack(alignment: .leading, spacing: 0) { content() }
        .padding(.top, above).padding(.bottom, below)
    }
    .contentMargins(.top, above, for: .scrollIndicators)
    .contentMargins(.bottom, below, for: .scrollIndicators)
    // The page keeps its card at the bottom; the card's own text opens at its title and stays
    // put as a reason opens.
    .defaultScrollAnchor(.top, for: .initialOffset)
    .defaultScrollAnchor(.top, for: .alignment)
    .defaultScrollAnchor(.top, for: .sizeChanges)
    .scrollBounceBehavior(.basedOnSize, axes: .vertical)
    .scrollIndicatorsFlash(onAppear: true)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.containerSize.height
        < geometry.contentSize.height - OkouSpace.one
    } action: { _, more in
      hasMoreBelow = more
    }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y > OkouSpace.one
    } action: { _, more in
      hasMoreAbove = more
    }
    .mask {
      VStack(spacing: 0) {
        LinearGradient(
          colors: [.black.opacity(hasMoreAbove ? 0 : 1), .black], startPoint: .top,
          endPoint: .bottom
        )
        .frame(height: fade)
        Rectangle()
        LinearGradient(
          colors: [.black, .black.opacity(hasMoreBelow ? 0 : 1)], startPoint: .top,
          endPoint: .bottom
        )
        .frame(height: fade)
      }
    }
    .animation(reduceMotion ? nil : OkouMotion.transition, value: hasMoreBelow)
    .animation(reduceMotion ? nil : OkouMotion.transition, value: hasMoreAbove)
    .padding(.top, -above).padding(.bottom, -below)
  }

  /// The card's content height for the height it is given: all of it beside the actions, or
  /// without them only as much as the heading needs.
  private func contentRoom(within height: CGFloat) -> CGFloat {
    showsActions || headingHeight == 0 ? height : min(height, headingHeight)
  }

  private var measuredHeading: some View {
    heading.frame(maxWidth: .infinity, alignment: .leading)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        noteHeading($0)
      }
  }

  /// The actions always keep their whole height; only the heading gives way.
  private var measuredActions: some View {
    actions.fixedSize(horizontal: false, vertical: true).onGeometryChange(for: CGFloat.self) {
      $0.size.height
    } action: {
      noteActions($0)
    }
  }

  private func noteHeading(_ height: CGFloat) {
    headingHeight = height
    send()
  }

  private func noteActions(_ height: CGFloat) {
    actionsHeight = height
    send()
  }

  private func send() {
    guard headingHeight > 0, actionsHeight > 0 else { return }
    report?(headingHeight + spacing + actionsHeight)
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
