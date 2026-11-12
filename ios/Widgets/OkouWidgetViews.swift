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
      case .systemMedium: OkouMediumWidget(model: model)
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

/// The quiet state's header: the mascot, the greeting and the actions on one line, so the rest
/// of the widget is free for chats. The widget's name already shows under it on the Home Screen.
struct OkouQuietHeader: View {
  let model: OkouWidgetModel
  let avatar: CGFloat
  let greeting: CGFloat

  var body: some View {
    // No stack spacing: a spacer would take a gap of its own and leave the greeting short.
    HStack(alignment: .center, spacing: 0) {
      OkouMascot(mood: model.mood, size: avatar)
        .padding(.trailing, 10)
      OkouGreeting(model: model, size: greeting, prefersOneLine: true)
      Spacer(minLength: 8)
      OkouWidgetActions()
    }
  }
}

/// Chat rows of one fixed height with the sidebar's hairlines between them — none beside the
/// orange card, which carries its own edge. Medium and large widgets show two and six of them
/// whether or not anything is running, so both states keep one rhythm.
struct OkouChatList: View {
  static let rowHeight: CGFloat = 42
  let chats: [OkouWidgetChat]
  let model: OkouWidgetModel

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
        OkouChatRow(chat: chat, model: model)
          .frame(height: Self.rowHeight)
        if index < chats.count - 1 && chat.state != .needsYou
          && chats[index + 1].state != .needsYou
        {
          Divider().overlay(OkouColor.border).padding(.leading, 30)
        }
      }
    }
  }
}

/// The busy header for medium and large widgets: the mascot, the name and what is live right
/// now — the counts the rows below cannot all show.
struct OkouBusyHeader: View {
  let model: OkouWidgetModel

  var body: some View {
    HStack(spacing: 8) {
      OkouMascot(mood: model.mood, size: 26)
      Text("Okou")
        .font(.okouWidget(14, weight: .semibold))
        .foregroundStyle(OkouColor.foreground)
      summary
        .font(.okouWidget(12, weight: .medium))
        .lineLimit(1)
      Spacer(minLength: 0)
      OkouWidgetActions()
    }
    .frame(height: 30)
  }

  private var summary: Text {
    var parts: [Text] = []
    if !model.needs.isEmpty {
      parts.append(
        Text("\(model.needs.count) needs you").foregroundStyle(OkouStatusColor.warning))
    }
    if !model.working.isEmpty {
      parts.append(
        Text("\(model.working.count) working").foregroundStyle(OkouColor.mutedForeground))
    }
    if parts.isEmpty && !model.finished.isEmpty {
      parts.append(
        Text("\(model.finished.count) finished").foregroundStyle(OkouColor.mutedForeground))
    }
    var result = Text("")
    for (index, part) in parts.enumerated() {
      if index > 0 { result = result + Text(" · ").foregroundStyle(OkouColor.quietMark) }
      result = result + part
    }
    return result
  }
}

/// New chat and voice, as round buttons at a widget's top trailing corner.
struct OkouWidgetActions: View {
  var body: some View {
    HStack(spacing: 6) {
      Link(destination: OkouWidgetLink.voice) {
        OkouGlyph(name: "mic", size: 15)
          .foregroundStyle(OkouColor.foreground)
          .frame(width: 30, height: 30)
          .background(OkouColor.muted, in: Circle())
      }
      .accessibilityLabel("Voice")
      Link(destination: OkouWidgetLink.newChat) {
        OkouGlyph(name: "square-pen", size: 14)
          .foregroundStyle(OkouColor.background)
          .frame(width: 30, height: 30)
          .background(OkouColor.foreground, in: Circle())
          .widgetAccentable()
      }
      .accessibilityLabel("New chat")
    }
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
/// keeps the row's height on a soft orange ground with Review.
struct OkouChatRow: View {
  let chat: OkouWidgetChat
  let model: OkouWidgetModel

  var body: some View {
    Link(destination: OkouWidgetLink.chat(chat, workspaceID: model.snapshot.workspaceID)) {
      HStack(spacing: 10) {
        leading.frame(width: 20)
        Text(chat.title)
          .font(.okouWidget(14.5, weight: chat.state == .needsYou ? .semibold : .medium))
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
      HStack(spacing: 7) {
        OkouWorkingDot()
        Text(chat.activityAt, style: .timer)
          .font(.okouWidget(13, mono: true))
          .foregroundStyle(OkouColor.mutedForeground)
          .monospacedDigit()
          .frame(maxWidth: 52, alignment: .trailing)
      }
    case .finished:
      Circle().fill(OkouStatusColor.running).frame(width: 8, height: 8).widgetAccentable()
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
      HStack(spacing: 5) {
        OkouMascot(mood: model.mood, size: 26)
        Text(label(chat))
          .font(.okouWidget(12, weight: .semibold))
          .foregroundStyle(labelColor(chat))
          .lineLimit(1)
          .widgetAccentable()
        Spacer(minLength: 0)
      }
      .frame(height: 26)
      Text(chat.title)
        .font(.okouWidget(15, weight: .semibold, relativeTo: .headline))
        .foregroundStyle(OkouColor.foreground)
        .lineLimit(4)
        .minimumScaleFactor(0.85)
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

  var body: some View {
    if model.isQuiet {
      // Nothing to report: the greeting is the header, and the room below goes to the chats
      // people come back to.
      VStack(alignment: .leading, spacing: 0) {
        OkouQuietHeader(model: model, avatar: 44, greeting: 17)
        OkouChatList(chats: model.rows(2), model: model)
          .padding(.top, 6)
      }
      .widgetURL(OkouWidgetLink.newChat)
    } else {
      VStack(alignment: .leading, spacing: 0) {
        OkouBusyHeader(model: model)
        OkouChatList(chats: model.rows(2), model: model)
          .padding(.top, 6)
        Spacer(minLength: 0)
      }
    }
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
        OkouBusyHeader(model: model)
        OkouChatList(chats: model.rows(6), model: model)
          .padding(.top, 10)
        Spacer(minLength: 0)
        updatedLabel
      }
    }
  }

  private var updatedLabel: some View {
    Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
      .font(.okouWidget(12))
      .foregroundStyle(OkouColor.quietMark)
  }

  /// Nothing to report: the greeting is the header, the freshness note sits on the list's
  /// heading, and six chats — pinned first, then recent — share the rest of the height.
  private var quiet: some View {
    let chats = model.rows(6)
    return VStack(alignment: .leading, spacing: 0) {
      OkouQuietHeader(model: model, avatar: 48, greeting: 17)
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
      Spacer(minLength: 0)
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
    if !model.working.isEmpty { parts.append(String(localized: "\(model.working.count) working")) }
    if !model.finished.isEmpty {
      parts.append(String(localized: "\(model.finished.count) finished"))
    }
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
    } else if !model.working.isEmpty {
      Text("Okou: \(model.working.count) working")
    } else if !model.finished.isEmpty {
      Text("Okou: \(model.finished.count) finished")
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
        Spacer(minLength: 0)
      }
    case .systemLarge:
      VStack(alignment: .leading, spacing: 0) {
        header(avatar: 44)
        OkouPlaceholderRows(count: 6).padding(.top, 16)
        Spacer(minLength: 0)
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
        .frame(height: OkouChatList.rowHeight)
        .opacity(1 - Double(index) * 0.12)
        if index < count - 1 {
          Divider().overlay(OkouColor.border).padding(.leading, 30)
        }
      }
    }
    .accessibilityHidden(true)
  }
}
