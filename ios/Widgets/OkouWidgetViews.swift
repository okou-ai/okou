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
      OkouSignedOutWidget(isSystem: isSystem)
    }
  }
}

// MARK: - Shared pieces

/// The mascot in one of its moods. Tinted and clear Home Screens draw it desaturated, so the
/// mood reads from the face and props rather than the colours.
struct OkouMascot: View {
  let mood: OkouWidgetMood
  let size: CGFloat

  var body: some View {
    Image("Mascot-" + mood.rawValue)
      .resizable()
      .widgetAccentedRenderingMode(.desaturated)
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityHidden(true)
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

/// A chat as the sidebar draws it: the status emoji or the quiet chat glyph, the title, and one
/// trailing state. A request waiting for approval leads on an orange ground with Review.
struct OkouChatRow: View {
  let chat: OkouWidgetChat
  let model: OkouWidgetModel
  var showsDetail = true

  var body: some View {
    Link(destination: OkouWidgetLink.chat(chat, workspaceID: model.snapshot.workspaceID)) {
      HStack(spacing: 10) {
        leading.frame(width: 20)
        VStack(alignment: .leading, spacing: 1) {
          Text(chat.title)
            .font(.okouWidget(14.5, weight: chat.state == .idle ? .medium : .semibold))
            .foregroundStyle(OkouColor.foreground)
            .lineLimit(1)
            .privacySensitive()
          if showsDetail, let detail {
            Text(detail)
              .font(.okouWidget(12))
              .foregroundStyle(OkouColor.mutedForeground)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 6)
        trailing
      }
      .padding(.horizontal, chat.state == .needsYou ? 8 : 0)
      .frame(maxHeight: .infinity)
      .background {
        if chat.state == .needsYou {
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(OkouStatusColor.warning.opacity(0.12))
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

  private var detail: String? {
    switch chat.state {
    case .needsYou: String(localized: "Waiting for your OK")
    case .working: String(localized: "Working")
    case .finished: String(localized: "Finished")
    case .draft, .idle: nil
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
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top) {
        OkouMascot(mood: model.mood, size: 78)
          .padding(.leading, -10)
          .padding(.top, -8)
        Spacer(minLength: 0)
        trailing.padding(.top, 1)
      }
      Spacer(minLength: 0)
      if let chat = model.lead {
        Text(label(chat))
          .font(.okouWidget(12, weight: .semibold))
          .foregroundStyle(labelColor(chat))
          .widgetAccentable()
        Text(chat.title)
          .font(.okouWidget(15, weight: .semibold, relativeTo: .headline))
          .foregroundStyle(OkouColor.foreground)
          .lineLimit(2)
          .padding(.top, 2)
          .privacySensitive()
      } else {
        Text(model.greeting)
          .font(.okouWidget(17, weight: .semibold, relativeTo: .headline))
          .foregroundStyle(OkouColor.foreground)
          .lineLimit(2)
        Text(model.quietNote)
          .font(.okouWidget(12))
          .foregroundStyle(OkouColor.mutedForeground)
          .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .widgetURL(url)
  }

  private var url: URL {
    if let chat = model.lead {
      return OkouWidgetLink.chat(chat, workspaceID: model.snapshot.workspaceID)
    }
    return OkouWidgetLink.newChat
  }

  @ViewBuilder private var trailing: some View {
    if let chat = model.lead {
      if chat.state == .working {
        Text(chat.activityAt, style: .timer)
          .font(.okouWidget(12, mono: true))
          .foregroundStyle(OkouColor.mutedForeground)
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 56, alignment: .trailing)
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
    case .working: String(localized: "Working on")
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
    VStack(alignment: .leading, spacing: 0) {
      header
      if model.isQuiet {
        Spacer(minLength: 0)
        HStack(alignment: .bottom, spacing: 12) {
          OkouMascot(mood: model.mood, size: 84)
            .padding(.leading, -10)
            .padding(.bottom, -6)
          VStack(alignment: .leading, spacing: 5) {
            Text(model.greeting)
              .font(.okouWidget(19, weight: .semibold, relativeTo: .headline))
              .foregroundStyle(OkouColor.foreground)
              .lineLimit(2)
            Text(model.quietNote)
              .font(.okouWidget(12))
              .foregroundStyle(OkouColor.mutedForeground)
          }
          .padding(.bottom, 6)
        }
        .widgetURL(OkouWidgetLink.newChat)
      } else {
        VStack(spacing: 4) {
          ForEach(model.rows(2)) { chat in
            OkouChatRow(chat: chat, model: model)
          }
        }
        .padding(.top, 6)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 8) {
      if !model.isQuiet {
        OkouMascot(mood: model.mood, size: 30).padding(.leading, -6).padding(.top, -4)
      }
      Text("Okou")
        .font(.okouWidget(14, weight: .semibold))
        .foregroundStyle(OkouColor.foreground)
      Spacer(minLength: 0)
      OkouWidgetActions()
    }
    .frame(height: 30)
  }
}

// MARK: - Large

struct OkouLargeWidget: View {
  let model: OkouWidgetModel
  let updated: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        if !model.isQuiet {
          OkouMascot(mood: model.mood, size: 30).padding(.leading, -6).padding(.top, -4)
        }
        Text("Okou")
          .font(.okouWidget(14, weight: .semibold))
          .foregroundStyle(OkouColor.foreground)
        if !model.isQuiet {
          Text("Today").font(.okouWidget(12)).foregroundStyle(OkouColor.mutedForeground)
        }
        Spacer(minLength: 0)
        OkouWidgetActions()
      }
      .frame(height: 30)
      if model.isQuiet { quiet } else { busy }
      Spacer(minLength: 0)
      Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
        .font(.okouWidget(12))
        .foregroundStyle(OkouColor.quietMark)
    }
  }

  private var busy: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        tile(model.needs.count, String(localized: "needs you"), OkouStatusColor.warning)
        tile(model.working.count, String(localized: "working"), OkouStatusColor.running)
        tile(model.finished.count, String(localized: "finished"), OkouStatusColor.success)
      }
      .padding(.top, 10)
      VStack(spacing: 0) {
        let rows = model.rows(5)
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, chat in
          OkouChatRow(chat: chat, model: model, showsDetail: chat.state == .needsYou)
            .frame(height: chat.state == .needsYou ? 50 : 38)
          if index < rows.count - 1 && chat.state != .needsYou
            && rows[index + 1].state != .needsYou
          {
            Divider().overlay(OkouColor.border).padding(.leading, 30)
          }
        }
      }
      .padding(.top, 10)
    }
  }

  private var quiet: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        OkouMascot(mood: model.mood, size: 76).padding(.leading, -10)
        VStack(alignment: .leading, spacing: 4) {
          Text(model.greeting)
            .font(.okouWidget(19, weight: .semibold, relativeTo: .headline))
            .foregroundStyle(OkouColor.foreground)
            .lineLimit(2)
          Text(model.quietNote)
            .font(.okouWidget(12))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .padding(.top, 8)
      let chats = model.pinned.isEmpty ? model.rows(4) : Array(model.pinned.prefix(4))
      Text(model.pinned.isEmpty ? "Recent" : "Pinned")
        .font(.okouWidget(12, weight: .semibold))
        .foregroundStyle(OkouColor.quietMark)
        .padding(.top, 12)
      VStack(spacing: 0) {
        ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
          OkouChatRow(chat: chat, model: model, showsDetail: false).frame(height: 38)
          if index < chats.count - 1 {
            Divider().overlay(OkouColor.border).padding(.leading, 30)
          }
        }
      }
    }
  }

  private func tile(_ count: Int, _ label: String, _ color: Color) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      // A zero stays quiet so the counts that matter lead.
      Text("\(count)")
        .font(.okouWidget(21, mono: true))
        .foregroundStyle(count == 0 ? OkouColor.quietMark : OkouColor.foreground)
      HStack(spacing: 5) {
        Circle().fill(count == 0 ? OkouColor.quietMark : color).frame(width: 7, height: 7)
          .widgetAccentable()
        Text(label).font(.okouWidget(11.5)).foregroundStyle(OkouColor.mutedForeground)
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 11)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(OkouColor.muted, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
      OkouMascot(mood: model.mood, size: 46)
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

struct OkouSignedOutWidget: View {
  let isSystem: Bool

  var body: some View {
    if isSystem {
      VStack(alignment: .leading, spacing: 4) {
        OkouMascot(mood: .sleep, size: 64).padding(.leading, -8)
        Spacer(minLength: 0)
        Text("Open Okou to sign in")
          .font(.okouWidget(15, weight: .semibold))
          .foregroundStyle(OkouColor.foreground)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    } else {
      Text("Open Okou to sign in").font(.okouWidget(13))
    }
  }
}
