import ChatData
import Foundation

typealias OkouWidgetChat = OkouWidgetSnapshot.Chat

/// The part of the day picks the greeting and the mascot's quiet mood.
enum OkouWidgetMoment {
  case morning, day, evening, night

  init(_ date: Date, calendar: Calendar = .current) {
    let hour = calendar.component(.hour, from: date)
    if hour >= 5 && hour < 11 {
      self = .morning
    } else if hour >= 11 && hour < 17 {
      self = .day
    } else if hour >= 17 && hour < 22 {
      self = .evening
    } else {
      self = .night
    }
  }

  /// The next day's worth of part-of-day changes, for the timeline.
  static func boundaries(after date: Date, calendar: Calendar = .current) -> [Date] {
    var dates: [Date] = []
    for hour in [5, 11, 17, 22] {
      let components = DateComponents(hour: hour)
      if let next = calendar.nextDate(
        after: date, matching: components, matchingPolicy: .nextTime)
      {
        dates.append(next)
      }
    }
    return dates.sorted()
  }
}

/// The mascot's moods, each the hero frame of one of Liangyou's 21 Okou moods, rendered from
/// the avatar rig: ready 发呆, evening 开心, working 思考, needs 拜托, done 庆祝, oops 汗颜,
/// sleep 困困. Every mood has a hero asset for large faces and a mini one for small faces
/// (`Mascot-<mood>-hero` / `-mini`), each drawn with lines weighted for its size.
enum OkouWidgetMood: String {
  case ready, evening, working, needs, done, oops, sleep
}

/// What one widget entry shows: the chats by state, in the order the widget lists them.
struct OkouWidgetModel {
  let snapshot: OkouWidgetSnapshot
  let date: Date
  let needs: [OkouWidgetChat]
  let working: [OkouWidgetChat]
  let finished: [OkouWidgetChat]
  let pinned: [OkouWidgetChat]
  let moment: OkouWidgetMoment

  init(snapshot: OkouWidgetSnapshot, date: Date) {
    self.snapshot = snapshot
    self.date = date
    var needs: [OkouWidgetChat] = []
    var working: [OkouWidgetChat] = []
    var finished: [OkouWidgetChat] = []
    var pinned: [OkouWidgetChat] = []
    for chat in snapshot.chats {
      switch chat.state {
      case .needsYou: needs.append(chat)
      case .working: working.append(chat)
      case .finished: finished.append(chat)
      case .draft, .idle: if chat.isPinned { pinned.append(chat) }
      }
    }
    self.needs = needs
    self.working = working
    self.finished = finished
    self.pinned = pinned
    moment = OkouWidgetMoment(date)
  }

  /// Nothing waits, works or finished unread: the widget greets instead of listing.
  var isQuiet: Bool { needs.isEmpty && working.isEmpty && finished.isEmpty }

  /// The one chat a small widget shows: what needs you, else what's working, else what finished.
  var lead: OkouWidgetChat? { needs.first ?? working.first ?? finished.first }

  /// Rows in the order every list shows them, filled with the rest of the snapshot.
  func rows(_ count: Int) -> [OkouWidgetChat] {
    var rows = needs + working + finished
    for chat in snapshot.chats where !rows.contains(where: { $0.id == chat.id }) {
      rows.append(chat)
    }
    return Array(rows.prefix(count))
  }

  var mood: OkouWidgetMood {
    if !needs.isEmpty { return .needs }
    if !working.isEmpty { return .working }
    if !finished.isEmpty { return .done }
    switch moment {
    case .night: return .sleep
    case .evening: return .evening
    case .morning, .day: return .ready
    }
  }

  var greeting: String {
    switch moment {
    case .morning: snapshot.greetings.morning
    case .day: snapshot.greetings.day
    case .evening: snapshot.greetings.evening
    case .night: snapshot.greetings.night
    }
  }

  var quietNote: String {
    moment == .night
      ? String(localized: "All quiet tonight") : String(localized: "Nothing running")
  }
}

/// Short relative times for a row's trailing edge: "Just now", "4m", "2h", "Mon".
enum OkouWidgetTime {
  static func short(_ date: Date, now: Date) -> String {
    let seconds = now.timeIntervalSince(date)
    if seconds < 60 { return String(localized: "Just now") }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    return date.formatted(.dateTime.weekday(.abbreviated))
  }
}

/// Links into the App (`OkouWidgetLinks` there): a chat, a new chat, or voice input.
enum OkouWidgetLink {
  private static let scheme =
    Bundle.main.object(forInfoDictionaryKey: "OkouAppURLScheme") as? String ?? "ai.okou.ios"

  static let newChat = URL(string: scheme + "://widget/new")!
  static let voice = URL(string: scheme + "://widget/voice")!

  static func chat(_ chat: OkouWidgetChat, workspaceID: String) -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = "widget"
    components.path = "/chat/" + chat.id
    components.queryItems = [URLQueryItem(name: "workspace", value: workspaceID)]
    return components.url ?? newChat
  }
}

extension OkouWidgetSnapshot {
  /// The gallery preview and placeholder: one request waiting, one chat working, two finished.
  static var sample: OkouWidgetSnapshot {
    let now = Date.now
    return OkouWidgetSnapshot(
      workspaceID: "sample",
      greetings: Greetings(
        morning: "Coffee's ready.", day: "What's the move?", evening: "Another win today?",
        night: "Saved your seat."),
      chats: [
        Chat(
          id: "a", title: "Send 3 follow-up emails?", emoji: nil, state: .needsYou,
          isPinned: false, activityAt: now.addingTimeInterval(-240)),
        Chat(
          id: "b", title: "Reviewing GitHub Issue 35625 for Okou", emoji: "⏳", state: .working,
          isPinned: false, activityAt: now.addingTimeInterval(-724)),
        Chat(
          id: "c", title: "!45711 用量状态配色与提示优化", emoji: "✅", state: .finished,
          isPinned: false, activityAt: now.addingTimeInterval(-1080)),
        Chat(
          id: "d", title: "!45375 侧栏入口统一点击展开", emoji: "✅", state: .finished,
          isPinned: false, activityAt: now.addingTimeInterval(-3600)),
        Chat(
          id: "e", title: "请求与Okou互动", emoji: nil, state: .draft, isPinned: false,
          activityAt: now.addingTimeInterval(-7200)),
      ])
  }
}
