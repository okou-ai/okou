import ChatData
import SwiftUI
import WidgetKit

struct OkouStatusWidgetView: View {
  let entry: OkouStatusEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    content
      .containerBackground(for: .widget) {
        if isSystem { OkouColor.background } else { Color.clear }
      }
  }

  private var isSystem: Bool {
    family == .systemSmall || family == .systemMedium || family == .systemLarge
  }

  @ViewBuilder private var content: some View {
    if let snapshot = entry.snapshot {
      let model = OkouWidgetModel(snapshot: snapshot, date: entry.date)
      switch family {
      case .systemSmall: OkouSmallWidget(model: model)
      case .systemMedium: OkouMediumWidget(model: model, updated: entry.date)
      case .systemLarge: OkouLargeWidget(model: model, updated: entry.date)
      case .accessoryRectangular: OkouRectangularWidget(model: model)
      case .accessoryCircular: OkouCircularWidget(model: model)
      default: OkouInlineWidget(model: model)
      }
    } else {
      OkouSignedOutWidget(family: family)
    }
  }
}

// MARK: - Shared pieces

/// The mascot in one of its moods: on the Home Screen the avatar lab's textured square with soft
/// continuous corners, on the Lock Screen the plain bust. Tinted and clear Home Screens draw it desaturated, so the mood
/// reads from the face and props rather than the colours. When the mood changes between
/// entries the old face blurs into the new one.
struct OkouMascot: View {
  let mood: OkouWidgetMood
  let size: CGFloat
  /// Shrinks below `size` when the text beside it needs the room; text never gives way to it.
  var yields = false
  var textured = true

  var body: some View {
    let image = Image((textured ? "Avatar-" : "Mascot-") + mood.rawValue)
      .resizable()
      .widgetAccentedRenderingMode(.desaturated)
      .scaledToFit()
      .clipShape(OkouAvatarShape(cornered: textured))
      .accessibilityHidden(true)
    Group {
      if yields {
        image.frame(maxWidth: size, maxHeight: size, alignment: .topLeading)
      } else {
        image.frame(width: size, height: size)
      }
    }
    .id(mood)
    .transition(.blurReplace)
  }
}

struct OkouGlyph: View {
  let name: String
  var size: CGFloat = 16

  var body: some View {
    Image("Lucide-" + name)
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/// The avatar tile's outline: a square whose corners take 30 % of its side with continuous
/// curvature — the iOS smoothing Figma's corner smoothing imitates — so they read very soft at
/// every size. The plain bust is left unclipped.
struct OkouAvatarShape: Shape {
  let cornered: Bool

  func path(in rect: CGRect) -> Path {
    guard cornered else { return Path(rect) }
    let radius = min(rect.width, rect.height) * 0.3
    return Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
  }
}

/// The quiet greeting and its note. Both keep their full height — up to two lines of greeting —
/// and the mascot beside or above them is the one that gives way.
struct OkouGreeting: View {
  let model: OkouWidgetModel
  let size: CGFloat
  /// Beside the actions in a header the greeting keeps to one line: at full size if it fits,
  /// two points smaller if that fits, and only then on two lines — never broken a word short.
  var prefersOneLine = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if prefersOneLine {
        ViewThatFits(in: .horizontal) {
          greeting(size).lineLimit(1)
          greeting(size - 2).lineLimit(1)
          greeting(size - 2).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
      } else {
        greeting(size)
          .lineLimit(2)
          .minimumScaleFactor(0.85)
          .fixedSize(horizontal: false, vertical: true)
      }
      Text(model.quietNote)
        .font(.okouWidget(12))
        .foregroundStyle(OkouColor.mutedForeground)
        .lineLimit(1)
    }
    .layoutPriority(1)
  }

  private func greeting(_ points: CGFloat) -> some View {
    Text(model.greeting)
      .font(.okouWidget(points, weight: .semibold, relativeTo: .headline))
      .foregroundStyle(OkouColor.foreground)
  }
}

/// Every medium and large widget's header, in one geometry for every state: the mascot, a
/// title with a note under it, and New chat. Quiet, the title is the greeting and the note says
/// nothing is running; busy, the title counts what needs you, what is unread and what is
/// working, and the note says when the widget last refreshed. A widget that changes state keeps
/// its shape, and the mascot stays the size that balances the button.
struct OkouHeader: View {
  let model: OkouWidgetModel
  let avatar: CGFloat
  let updated: Date

  var body: some View {
    // No stack spacing: a spacer would take a gap of its own and leave the title short.
    HStack(alignment: .center, spacing: 0) {
      OkouMascot(mood: model.mood, size: avatar)
        .padding(.trailing, 10)
      if model.isQuiet {
        OkouGreeting(model: model, size: 17, prefersOneLine: true)
      } else {
        OkouStatusTitle(model: model, updated: updated)
      }
      Spacer(minLength: 8)
      OkouNewChatButton()
    }
  }
}

/// The busy title: the counts in the list's order, each in its row's colour, at the greeting's
/// size. When they don't all fit, the title steps down two points before the later counts
/// step back.
struct OkouStatusTitle: View {
  private struct Fit: Hashable {
    let count: Int
    let size: CGFloat
  }

  let model: OkouWidgetModel
  let updated: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ViewThatFits(in: .horizontal) {
        ForEach(fits, id: \.self) { fit in
          summary(parts.prefix(fit.count))
            .font(.okouWidget(fit.size, weight: .semibold, relativeTo: .headline))
            .lineLimit(1)
        }
      }
      Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
        .font(.okouWidget(12))
        .foregroundStyle(OkouColor.mutedForeground)
        .lineLimit(1)
    }
    .layoutPriority(1)
  }

  private var fits: [Fit] {
    stride(from: max(parts.count, 1), through: 1, by: -1).flatMap { count in
      [Fit(count: count, size: 17), Fit(count: count, size: 15)]
    }
  }

  private var parts: [Text] {
    var parts: [Text] = []
    if !model.needs.isEmpty {
      parts.append(
        Text("\(model.needs.count) needs you").foregroundStyle(OkouStatusColor.warning))
    }
    if !model.finished.isEmpty {
      parts.append(
        Text("\(model.finished.count) unread").foregroundStyle(OkouStatusColor.running))
    }
    if !model.working.isEmpty {
      parts.append(Text("\(model.working.count) working").foregroundStyle(OkouColor.foreground))
    }
    return parts
  }

  private func summary(_ parts: ArraySlice<Text>) -> Text {
    var result = Text("")
    for (index, part) in parts.enumerated() {
      if index > 0 { result = result + Text(" · ").foregroundStyle(OkouColor.quietMark) }
      result = result + part
    }
    return result
  }
}

/// Chat rows with the sidebar's hairlines between them — none beside the orange card, which
/// carries its own edge. Medium and large widgets show two and six of them whether or not
/// anything is running, so both states keep one rhythm. The rows share the height under the
/// header, within a range that keeps them a list on every iPhone size, so the widget has no
/// empty foot; a short list keeps its rows at the top.
struct OkouChatList: View {
  static let rowHeights: ClosedRange<CGFloat> = 36...52
  let chats: [OkouWidgetChat]
  let model: OkouWidgetModel

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
        OkouChatRow(chat: chat, model: model)
          .frame(minHeight: Self.rowHeights.lowerBound, maxHeight: Self.rowHeights.upperBound)
        if index < chats.count - 1 && chat.state != .needsYou
          && chats[index + 1].state != .needsYou
        {
          Divider().overlay(OkouColor.border).padding(.leading, 30)
        }
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
  }
}

/// New chat, as one round button at a widget's top trailing corner. Voice keeps its control
/// in Control Center, on the Lock Screen and on the Action button; a second button here would
/// shrink both and sit close enough to mis-tap.
struct OkouNewChatButton: View {
  static let size: CGFloat = 36

  var body: some View {
    Link(destination: OkouWidgetLink.newChat) {
      OkouGlyph(name: "square-pen", size: 16)
        .foregroundStyle(OkouColor.background)
        .frame(width: Self.size, height: Self.size)
        .background(OkouColor.foreground, in: Circle())
        .widgetAccentable()
    }
    .accessibilityLabel("New chat")
  }
}

/// The running indicator a widget can draw: the App's sky dot with a still ring.
struct OkouWorkingDot: View {
  var body: some View {
    Circle()
      .fill(OkouStatusColor.running)
      .frame(width: 9, height: 9)
      .background(Circle().fill(OkouStatusColor.running.opacity(0.3)).frame(width: 15, height: 15))
      .widgetAccentable()
      .accessibilityHidden(true)
  }
}

/// A chat as the sidebar draws it: the status emoji or the quiet chat glyph, one line of title,
/// and one trailing state. Every row has the same shape, so a list keeps one rhythm; whole
/// titles belong to the small widget, which shows one chat. A request waiting for approval
/// keeps the row's height on a soft orange ground with Review. Unread results set their title
/// in semibold, as Mail does, and every blue dot — unread or working — sits in one column at
/// the trailing edge, a running timer to its left.
struct OkouChatRow: View {
  static let dotColumn: CGFloat = 15
  let chat: OkouWidgetChat
  let model: OkouWidgetModel

  private var isEmphasized: Bool { chat.state == .needsYou || chat.state == .finished }

  var body: some View {
    Link(destination: OkouWidgetLink.chat(chat, workspaceID: model.snapshot.workspaceID)) {
      HStack(spacing: 10) {
        leading.frame(width: 20)
        Text(chat.title)
          .font(.okouWidget(14.5, weight: isEmphasized ? .semibold : .regular))
          .foregroundStyle(OkouColor.foreground)
          .lineLimit(1)
          .privacySensitive()
        Spacer(minLength: 6)
        trailing
      }
      .padding(.horizontal, chat.state == .needsYou ? 8 : 0)
      .frame(maxHeight: .infinity)
      .background {
        if chat.state == .needsYou {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(OkouStatusColor.warning.opacity(0.12))
            .padding(.vertical, 2)
        }
      }
      .padding(.horizontal, chat.state == .needsYou ? -8 : 0)
    }
  }

  @ViewBuilder private var leading: some View {
    if chat.state == .needsYou {
      OkouGlyph(name: "shield-alert", size: 17).foregroundStyle(OkouStatusColor.warning)
        .widgetAccentable()
    } else if let emoji = chat.emoji {
      Text(emoji).font(.system(size: 15))
    } else {
      OkouGlyph(name: "message-circle", size: 15).foregroundStyle(OkouColor.quietMark)
    }
  }

  @ViewBuilder private var trailing: some View {
    switch chat.state {
    case .needsYou:
      Text("Review")
        .font(.okouWidget(12.5, weight: .semibold))
        .foregroundStyle(OkouStatusColor.warning)
        .padding(.horizontal, 11)
        .frame(height: 26)
        .background(OkouStatusColor.warning.opacity(0.18), in: Capsule())
        .widgetAccentable()
    case .working:
      HStack(spacing: 6) {
        // A timer takes all the width it is offered; the cap and trailing alignment keep it
        // against the dot.
        Text(chat.activityAt, style: .timer)
          .font(.okouWidget(13, mono: true))
          .foregroundStyle(OkouColor.mutedForeground)
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 58, alignment: .trailing)
        OkouWorkingDot().frame(width: Self.dotColumn)
      }
    case .finished:
      Circle().fill(OkouStatusColor.running).frame(width: 9, height: 9).widgetAccentable()
        .frame(width: Self.dotColumn)
        .accessibilityLabel("Unread")
    case .draft:
      OkouGlyph(name: "pencil", size: 13).foregroundStyle(OkouColor.quietMark)
    case .idle:
      Text(OkouWidgetTime.short(chat.activityAt, now: model.date))
        .font(.okouWidget(12))
        .foregroundStyle(OkouColor.mutedForeground)
    }
  }
}

// MARK: - Small

struct OkouSmallWidget: View {
  let model: OkouWidgetModel

  var body: some View {
    Group {
      if let chat = model.lead {
        active(chat)
      } else {
        quiet
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(url)
  }

  /// A chat leads: the mascot steps back to the state line so the title has the widget, up to
  /// four lines, as a notification gives its body the room. The time sits at the foot, where
  /// a running timer has the width it needs.
  private func active(_ chat: OkouWidgetChat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        OkouMascot(mood: model.mood, size: 30)
        Text(label(chat))
          .font(.okouWidget(13, weight: .semibold))
          .foregroundStyle(labelColor(chat))
          .lineLimit(1)
          .widgetAccentable()
        Spacer(minLength: 0)
      }
      .frame(height: 30)
      Text(chat.title)
        .font(.okouWidget(17, weight: .semibold, relativeTo: .headline))
        .foregroundStyle(OkouColor.foreground)
        .lineLimit(4)
        .minimumScaleFactor(0.8)
        .padding(.top, 8)
        .privacySensitive()
      Spacer(minLength: 4)
      time
    }
  }

  /// Nothing to report: the mascot is the widget, with the greeting under it.
  private var quiet: some View {
    VStack(alignment: .leading, spacing: 0) {
      OkouMascot(mood: model.mood, size: 60, yields: true)
      Spacer(minLength: 6)
      OkouGreeting(model: model, size: 17)
    }
  }

  private var url: URL {
    if let chat = model.lead {
      return OkouWidgetLink.chat(chat, workspaceID: model.snapshot.workspaceID)
    }
    return OkouWidgetLink.newChat
  }

  @ViewBuilder private var time: some View {
    if let chat = model.lead {
      if chat.state == .working {
        Text(chat.activityAt, style: .timer)
          .font(.okouWidget(12, mono: true))
          .foregroundStyle(OkouColor.mutedForeground)
          .monospacedDigit()
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text(OkouWidgetTime.short(chat.activityAt, now: model.date))
          .font(.okouWidget(12))
          .foregroundStyle(OkouColor.mutedForeground)
      }
    }
  }

  private func label(_ chat: OkouWidgetChat) -> String {
    switch chat.state {
    case .needsYou: String(localized: "Needs you")
    case .working: String(localized: "Working")
    default: String(localized: "Finished")
    }
  }

  private func labelColor(_ chat: OkouWidgetChat) -> Color {
    switch chat.state {
    case .needsYou: OkouStatusColor.warning
    case .working: OkouColor.mutedForeground
    default: OkouStatusColor.running
    }
  }
}

// MARK: - Medium

struct OkouMediumWidget: View {
  let model: OkouWidgetModel
  let updated: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      OkouHeader(model: model, avatar: 44, updated: updated)
      // Quiet, the room below the greeting goes to the chats people come back to.
      OkouChatList(chats: model.rows(2), model: model)
        .padding(.top, 6)
    }
    .widgetURL(model.isQuiet ? OkouWidgetLink.newChat : nil)
  }
}

// MARK: - Large

struct OkouLargeWidget: View {
  let model: OkouWidgetModel
  let updated: Date

  var body: some View {
    if model.isQuiet {
      quiet
    } else {
      VStack(alignment: .leading, spacing: 0) {
        OkouHeader(model: model, avatar: 48, updated: updated)
        OkouChatList(chats: model.rows(6), model: model)
          .padding(.top, 8)
      }
    }
  }

  private var updatedLabel: some View {
    Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
      .font(.okouWidget(12))
      .foregroundStyle(OkouColor.quietMark)
  }

  /// Nothing to report: the freshness note sits on the list's heading, and six chats — pinned
  /// first, then recent — share the rest of the height.
  private var quiet: some View {
    let chats = model.rows(6)
    return VStack(alignment: .leading, spacing: 0) {
      OkouHeader(model: model, avatar: 48, updated: updated)
      HStack {
        Text(listTitle(chats))
          .font(.okouWidget(12, weight: .semibold))
          .foregroundStyle(OkouColor.quietMark)
        Spacer(minLength: 8)
        updatedLabel
      }
      .padding(.top, 14)
      OkouChatList(chats: chats, model: model)
        .padding(.top, 2)
    }
    .widgetURL(OkouWidgetLink.newChat)
  }

  private func listTitle(_ chats: [OkouWidgetChat]) -> String {
    if chats.allSatisfy(\.isPinned) { return String(localized: "Pinned") }
    if !chats.contains(where: \.isPinned) { return String(localized: "Recent") }
    return String(localized: "Pinned and recent")
  }
}

// MARK: - Lock Screen

struct OkouRectangularWidget: View {
  let model: OkouWidgetModel

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 4) {
        if let chat = model.lead, chat.state == .needsYou {
          OkouGlyph(name: "shield-alert", size: 12)
        }
        Text(heading).font(.okouWidget(12, weight: .semibold))
      }
      if let chat = model.lead {
        Text(chat.title)
          .font(.okouWidget(15, weight: .semibold))
          .lineLimit(1)
          .privacySensitive()
        Text(summary).font(.okouWidget(12)).lineLimit(1)
      } else {
        Text(model.greeting).font(.okouWidget(14, weight: .semibold)).lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(
      model.lead.map { OkouWidgetLink.chat($0, workspaceID: model.snapshot.workspaceID) }
        ?? OkouWidgetLink.newChat)
  }

  private var heading: String {
    switch model.lead?.state {
    case .needsYou: String(localized: "Needs you")
    case .working: String(localized: "Working")
    case .finished: String(localized: "Finished")
    default: "Okou"
    }
  }

  private var summary: String {
    var parts: [String] = []
    if !model.finished.isEmpty { parts.append(String(localized: "\(model.finished.count) unread")) }
    if !model.working.isEmpty { parts.append(String(localized: "\(model.working.count) working")) }
    return parts.joined(separator: " · ")
  }
}

struct OkouCircularWidget: View {
  let model: OkouWidgetModel

  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      OkouMascot(mood: model.mood, size: 46, textured: false)
    }
    .widgetURL(OkouWidgetLink.newChat)
    .accessibilityLabel("Okou")
  }
}

struct OkouInlineWidget: View {
  let model: OkouWidgetModel

  var body: some View {
    if !model.needs.isEmpty {
      Text("Okou: \(model.needs.count) needs you")
    } else if !model.finished.isEmpty {
      Text("Okou: \(model.finished.count) unread")
    } else if !model.working.isEmpty {
      Text("Okou: \(model.working.count) working")
    } else {
      Text(model.greeting)
    }
  }
}

/// Signed out: the quiet state's frame with nothing private in it. Small invites sign-in under
/// the sleeping mascot; medium and large keep the header and show where chats will appear as
/// placeholder rows of the list's own height, fading down, as Apple's placeholders do. Tapping
/// anywhere opens the App, which asks for sign-in.
struct OkouSignedOutWidget: View {
  let family: WidgetFamily

  var body: some View {
    switch family {
    case .systemSmall:
      VStack(alignment: .leading, spacing: 0) {
        OkouMascot(mood: .sleep, size: 60, yields: true)
        Spacer(minLength: 6)
        VStack(alignment: .leading, spacing: 4) {
          title(17).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          note(lines: 2)
        }
        .layoutPriority(1)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    case .systemMedium:
      VStack(alignment: .leading, spacing: 0) {
        header(avatar: 44)
        OkouPlaceholderRows(count: 2).padding(.top, 6)
      }
    case .systemLarge:
      VStack(alignment: .leading, spacing: 0) {
        header(avatar: 48)
        OkouPlaceholderRows(count: 6).padding(.top, 8)
      }
    default:
      Text("Open Okou to sign in").font(.okouWidget(13))
    }
  }

  private func header(avatar: CGFloat) -> some View {
    HStack(alignment: .center, spacing: 0) {
      OkouMascot(mood: .sleep, size: avatar).padding(.trailing, 10)
      VStack(alignment: .leading, spacing: 4) {
        title(17).lineLimit(1).minimumScaleFactor(0.85)
        note(lines: 1).minimumScaleFactor(0.9)
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      Text("Open Okou")
        .font(.okouWidget(13, weight: .semibold))
        .foregroundStyle(OkouColor.background)
        .padding(.horizontal, 13)
        .frame(height: 30)
        .background(OkouColor.foreground, in: Capsule())
        .fixedSize()
        .widgetAccentable()
    }
  }

  private func title(_ size: CGFloat) -> some View {
    Text("Sign in to Okou")
      .font(.okouWidget(size, weight: .semibold, relativeTo: .headline))
      .foregroundStyle(OkouColor.foreground)
  }

  private func note(lines: Int) -> some View {
    Text("Your chats will show up here")
      .font(.okouWidget(12))
      .foregroundStyle(OkouColor.mutedForeground)
      .lineLimit(lines)
      .fixedSize(horizontal: false, vertical: true)
  }
}

/// Grey stand-ins for chat rows: the list's height, glyph column and hairlines, with bars of
/// varied length that fade row by row.
struct OkouPlaceholderRows: View {
  let count: Int
  private static let widths: [CGFloat] = [0.62, 0.46, 0.7, 0.38, 0.56, 0.5]

  var body: some View {
    VStack(spacing: 0) {
      ForEach(0..<count, id: \.self) { index in
        HStack(spacing: 10) {
          Circle().fill(OkouColor.border).frame(width: 16, height: 16).frame(width: 20)
          GeometryReader { proxy in
            Capsule()
              .fill(OkouColor.border)
              .frame(
                width: proxy.size.width * Self.widths[index % Self.widths.count], height: 10
              )
              .frame(maxHeight: .infinity, alignment: .center)
          }
          Capsule().fill(OkouColor.border).frame(width: 26, height: 8)
        }
        .frame(
          minHeight: OkouChatList.rowHeights.lowerBound,
          maxHeight: OkouChatList.rowHeights.upperBound
        )
        .opacity(1 - Double(index) * 0.12)
        if index < count - 1 {
          Divider().overlay(OkouColor.border).padding(.leading, 30)
        }
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityHidden(true)
  }
}
