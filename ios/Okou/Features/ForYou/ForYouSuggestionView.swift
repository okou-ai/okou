import ChatData
import SwiftUI

/// One suggestion: where it came from, what it proposes, and each direction with what
/// choosing it does. Dismissing it and writing a direction of one's own live in the page's dock.
struct ForYouSuggestionView: View {
  let suggestion: ForYouSuggestion
  /// The height the deck gives the card's content, or none to take its own (`ForYouCardLayout`).
  var height: CGFloat?
  /// The direction whose choice is under way, which shows its progress in place of its arrow.
  var pendingOptionID: String?
  /// While the member writes a direction of their own, the card stands above the input as its
  /// context: its title and reason only, within the height it is given. Its source steps aside
  /// with its directions, so the draft is never left behind for another chat.
  var isContext = false
  let openSource: (String) -> Void
  let choose: (ForYouOption) -> Void
  /// A direction's description keeps two lines, so two directions stay in view under a dense
  /// reason on a smaller phone.
  private static let descriptionLines = 2
  /// The card is a reading surface: a Title 3 heading over Body text, with Subheadline for
  /// secondary lines (docs/ios/mobile-design-system.md#type-roles).
  private static let labelFont = Font.okou(.body).weight(.medium)
  /// The room between directions: enough that each reads as its own button, little enough that
  /// the card keeps its room for the reason.
  private static let directionGap = OkouSpace.sm

  private var source: (id: String, title: String)? {
    let target = suggestion.options.compactMap(\.threadId).first
    let references = suggestion.options.flatMap { $0.draft.draftUserMessage?.parts ?? [] }
      .filter { $0["type"]?.string == "chat_thread" }
    let reference = references.first { $0["threadId"]?.string == target } ?? references.first
    guard let id = target ?? reference?["threadId"]?.string else { return nil }
    return (id, threadTitle(id) ?? String(localized: "View source"))
  }

  var body: some View {
    ForYouCardLayout(height: height, spacing: OkouSpace.xl, showsActions: !isContext) {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        lead
        if !suggestion.rationale.isEmpty { reason }
      }
    } actions: {
      VStack(spacing: Self.directionGap) {
        ForEach(suggestion.options) { option in
          optionButton(option)
        }
      }
    }
    .foregroundStyle(OkouColor.foreground)
  }

  /// Where the suggestion came from, and what it proposes.
  private var lead: some View {
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
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          .padding(.horizontal, OkouSpace.ten)
          .frame(minHeight: OkouControl.inlineActionHeight)
        }
        .buttonStyle(ForYouChipButtonStyle()).accessibilityHint("View source")
        .padding(.bottom, OkouSpace.xs)
        .transition(.opacity)
      }
      Text(suggestion.title).font(.okou(.title3).weight(.semibold))
        .accessibilityAddTraits(.isHeader).fixedSize(horizontal: false, vertical: true)
    }
  }

  /// Why Okou suggests it, whole. The card keeps one height, so a reason longer than its room
  /// scrolls there above the directions rather than opening behind a Show more that could only
  /// make it scroll.
  private var reason: some View {
    Text(suggestion.rationale).font(.okou(.body))
      .foregroundStyle(OkouColor.mutedForeground)
      .fixedSize(horizontal: false, vertical: true)
  }

  /// A direction says what choosing it does before it is chosen, in a short line above its label:
  /// one that sends says so in amber, one that only prepares a draft names the chat it drafts in.
  /// There is no mark beside the text, so the label and description keep the button's whole
  /// width. Each is a white button on the card's grey ground, as the web draws its options, and
  /// the one being chosen shows its progress in that line and along its foot until the choice
  /// settles.
  private func optionButton(_ option: ForYouOption) -> some View {
    let sends = option.threadId == nil
    let isPending = pendingOptionID == option.id
    return Button {
      choose(option)
    } label: {
      VStack(alignment: .leading, spacing: OkouSpace.six) {
        ForYouOptionAction(
          sends: sends, chat: option.threadId.flatMap(threadTitle), isPending: isPending)
        Text(option.label).font(Self.labelFont)
        // A long description keeps its first lines so a dense card leaves its heading room;
        // VoiceOver reads all of it.
        if !option.description.isEmpty {
          Text(option.description).font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(Self.descriptionLines)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .multilineTextAlignment(.leading)
      .padding(OkouSpace.lg)
      .frame(minHeight: OkouControl.minimumTarget)
      .overlay(alignment: .bottom) {
        if isPending { ForYouOptionProgress(sends: sends).transition(.opacity) }
      }
      // The progress line follows the button's rounded foot.
      .clipShape(RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous))
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
    ForYouCardLayout(height: height, spacing: OkouSpace.lg) {
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
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
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
      .font(.okou(.body)).foregroundStyle(OkouColor.mutedForeground)
      .fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        Text(verbatim: event.automationName).font(.okou(.body).weight(.medium))
        if let description = event.automationDescription, !description.isEmpty {
          Text(verbatim: description).font(.okou(.subheadline))
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
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
      }
    }
  }
}

/// The room between a card's edge and its content: more above the heading, where the card's
/// large corner curves. A heading that scrolls runs out to the card's edge through it.
enum ForYouCardInset {
  static let top = OkouSpace.xxl
  static let side = OkouSpace.xl
  /// Under the directions' own bordered rows, matching the sides.
  static let bottom = OkouSpace.xl
  /// Under a card that ends in text, as a direction's context does: as much as above, so the
  /// text sits evenly in the card.
  static let textBottom = top
}

/// A card's heading over its actions. Given the deck's height, the actions stay at the card's
/// bottom and the heading takes what is left, scrolling there when it is longer. A scrolling
/// heading runs out to the card's own edges, so its text comes and goes there rather than at the
/// card's inset, and its scroll indicator runs along the card's side; above the actions it stops
/// a gap short of them. It fades out at whichever end more lies beyond, and its indicator flashes
/// when it appears, so the reader can tell there is more. When the actions would leave the
/// heading less than a third of the card, as at the largest text sizes, heading and actions
/// scroll as one from the title. Without its actions, as while a direction is written, the
/// heading takes its own height up to the one given and runs out through the card's bottom edge
/// past it. Without a height the card takes its own.
struct ForYouCardLayout<Heading: View, Actions: View>: View {
  let height: CGFloat?
  let spacing: CGFloat
  let showsActions: Bool
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
    height: CGFloat?, spacing: CGFloat, showsActions: Bool = true,
    @ViewBuilder heading: () -> Heading, @ViewBuilder actions: () -> Actions
  ) {
    self.height = height
    self.spacing = spacing
    self.showsActions = showsActions
    self.heading = heading()
    self.actions = actions()
  }

  var body: some View {
    if let height {
      let pinsActions = showsActions && height - actionsHeight - spacing >= height * headingShare
      VStack(alignment: .leading, spacing: spacing) {
        scrolling(
          below: pinsActions
            ? 0 : showsActions ? ForYouCardInset.bottom : ForYouCardInset.textBottom
        ) {
          measuredHeading
          if showsActions && !pinsActions {
            measuredActions.padding(.top, spacing).transition(.opacity)
          }
        }
        if pinsActions { measuredActions.transition(.opacity) }
      }
      .frame(height: contentRoom(within: height), alignment: .top)
      // The heading's own height arrives a moment after the change that moved its text (the
      // source leaving as a direction opens), so the card eases to it rather than cutting the
      // text still on its way up.
      .animation(reduceMotion ? nil : OkouMotion.transition, value: headingHeight)
    } else {
      VStack(alignment: .leading, spacing: spacing) {
        measuredHeading
        if showsActions { measuredActions.transition(.opacity) }
      }
    }
  }

  /// Scrolls its content within the card. It reaches past the content by the card's insets on
  /// the sides and above, and by `below` underneath, keeping that room inside the scroll, so the
  /// text scrolls in and out at the card's edge instead of stopping short of it, and the scroll
  /// indicator runs along the card's side rather than beside the text.
  private func scrolling<Content: View>(
    below: CGFloat, @ViewBuilder _ content: () -> Content
  ) -> some View {
    let above = ForYouCardInset.top
    let side = ForYouCardInset.side
    return ScrollView {
      VStack(alignment: .leading, spacing: 0) { content() }
        .padding(.horizontal, side).padding(.top, above).padding(.bottom, below)
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
    // A heading that comes to run past its room (a direction opening, the text size changing)
    // flashes the indicator too, so it reads as something to scroll rather than as cut text.
    .scrollIndicatorsFlash(trigger: hasMoreBelow)
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
    .padding(.horizontal, -side).padding(.top, -above).padding(.bottom, -below)
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
        headingHeight = $0
      }
  }

  /// The actions always keep their whole height; only the heading gives way.
  private var measuredActions: some View {
    actions.fixedSize(horizontal: false, vertical: true).onGeometryChange(for: CGFloat.self) {
      $0.size.height
    } action: {
      actionsHeight = $0
    }
  }
}

/// What choosing a direction does, as a short line above its label: an amber dot and "Send to
/// a new chat" for one that sends now, a quiet dot and the chat's name for one that drafts, and
/// progress with "Sending…" while the choice is under way. VoiceOver hears it as the button's
/// hint instead.
private struct ForYouOptionAction: View {
  let sends: Bool
  /// The chat a draft opens in, when its title is known.
  let chat: String?
  let isPending: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private static let dot: CGFloat = 6

  /// Amber that reads as text: a deep stop on white, a light one at night.
  static let sendInk = Color(
    uiColor: UIColor { traits in
      UIColor(traits.userInterfaceStyle == .dark ? OkouColor.primary200 : OkouColor.primary700)
        .resolvedColor(with: traits)
    })

  private var text: LocalizedStringKey {
    if isPending { return sends ? "Sending…" : "Opening draft…" }
    if sends { return "Send to a new chat" }
    if let chat { return "Draft in \(chat)" }
    return "Draft in the existing chat"
  }

  var body: some View {
    HStack(spacing: OkouSpace.six) {
      ZStack {
        if isPending {
          ProgressView().controlSize(.mini).scaleEffect(0.7).transition(.opacity)
        } else {
          Circle().frame(width: Self.dot, height: Self.dot).transition(.opacity)
        }
      }
      .frame(width: OkouSpace.ten, height: OkouSpace.ten)
      .animation(reduceMotion ? nil : OkouMotion.press, value: isPending)
      // The words switch at once; fading one phrase into the other overlaps them.
      Text(text).lineLimit(1)
    }
    .font(.okou(.caption).weight(.semibold))
    .textCase(.uppercase)
    .tracking(0.5)
    .foregroundStyle(sends ? Self.sendInk : OkouColor.mutedForeground)
    .tint(sends ? Self.sendInk : OkouColor.mutedForeground)
    .accessibilityHidden(true)
  }
}

/// A thin line that runs along a chosen direction's foot while its choice is under way: amber
/// for one that sends, grey for one that drafts. Under Reduce Motion it holds still.
private struct ForYouOptionProgress: View {
  let sends: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var travels = false
  private static let height: CGFloat = 2
  private static let share: CGFloat = 0.4

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width * Self.share
      Capsule()
        .fill(sends ? OkouColor.primary : OkouColor.controlBorder)
        .frame(width: reduceMotion ? proxy.size.width : width, height: Self.height)
        .offset(x: reduceMotion ? 0 : (travels ? proxy.size.width : -width))
        .opacity(reduceMotion ? 0.6 : 1)
    }
    .frame(height: Self.height)
    .clipShape(Rectangle())
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: false)) { travels = true }
    }
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
    // The fill, its pressed state and the hairline all lie under the label, so the mark on the
    // corner covers the border instead of letting it run through.
    configuration.label
      .background {
        shape.fill(OkouColor.card)
          .overlay { shape.fill(pressed ? OkouColor.statePressed : .clear) }
          .overlay {
            shape.strokeBorder(
              pressed ? OkouColor.controlBorder : OkouColor.border, lineWidth: OkouSpace.hairline)
          }
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
