import ChatDomain
import Foundation

/// Timeline decorations follow the visible assistant groups and individual user messages.
struct ConversationTimeline {
  var now: Date = .now
  var calendar: Calendar = .current
  var locale: Locale = .current

  private struct DayStart {
    let row: Int
    let messageInsideShare: String?
    let day: Date
  }

  func rows(_ contents: [ConversationCollectionRow.Content], items: [ConversationItem])
    -> [ConversationCollectionRow]
  {
    let dates = Dictionary(
      uniqueKeysWithValues: items.compactMap(\.message).map { ($0.id, $0.createdAt) })
    var rows = contents.map { ConversationCollectionRow(content: $0) }
    var starts: [DayStart] = []
    var avatar: Int?
    func record(_ date: Date, at row: Int, inside share: String? = nil) {
      let day = calendar.startOfDay(for: date)
      if starts.last?.day != day {
        starts.append(DayStart(row: row, messageInsideShare: share, day: day))
      }
    }
    for (index, content) in contents.enumerated() {
      switch content {
      case .share(let group, _):
        avatar = group.messages.first?.role == .assistant ? index : nil
        for (offset, message) in group.messages.enumerated() {
          record(message.createdAt, at: index, inside: offset == 0 ? nil : message.id)
        }
      case .work(let section, _, _, _, _):
        avatar = index
        // A work header belongs to its visible answer, even when the prompt was yesterday.
        if let date = dates[section.anchorMessageID] { record(date, at: index) }
      case .message(let message, let showsAvatar, _, _, _, let workHistory, _):
        if message.role == .user {
          if !message.isQueued { avatar = nil }
          record(message.createdAt, at: index)
        } else if !workHistory && showsAvatar {
          avatar = index
          record(message.createdAt, at: index)
        }
      case .failure(let message, _, true, _, _):
        avatar = index
        record(message.createdAt, at: index)
      case .footer(_, true), .finished(_, _, true):
        avatar = index
      default: break
      }
    }
    if let avatar { rows[avatar].animatesAvatar = true }
    let today = calendar.startOfDay(for: now)
    let yesterday = calendar.date(byAdding: .day, value: -1, to: today)
    let showsToday = starts.contains { $0.day == yesterday }
    var leading: [Int: ConversationCollectionRow] = [:]
    for start in starts {
      guard
        let label = dayLabel(start.day, today: today, yesterday: yesterday, showsToday: showsToday)
      else { continue }
      if let id = start.messageInsideShare {
        rows[start.row].interiorDates[id] = label
      } else {
        leading[start.row] = ConversationCollectionRow(
          content: .dateDivider(before: rows[start.row].id, label: label))
      }
    }
    var result: [ConversationCollectionRow] = []
    for (index, row) in rows.enumerated() {
      if let divider = leading[index] { result.append(divider) }
      result.append(row)
    }
    return result
  }

  private func dayLabel(_ day: Date, today: Date, yesterday: Date?, showsToday: Bool) -> String? {
    if day == today { return showsToday ? String(localized: "Today", locale: locale) : nil }
    if day == yesterday { return String(localized: "Yesterday", locale: locale) }
    var style = dateStyle.month(.abbreviated).day()
    if !calendar.isDate(day, equalTo: today, toGranularity: .year) { style = style.year() }
    return day.formatted(style)
  }

  private var dateStyle: Date.FormatStyle {
    Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
  }

  func finishedLabel(
    _ completion: ChatRunCompletion, followups: ChatRecommendedFollowupSource?, finishedAt: Date?
  ) -> String {
    let style = dateStyle.month(.abbreviated).day().hour().minute()
    if followups != nil {
      guard let finishedAt else { return String(localized: "Keep going", locale: locale) }
      return String(localized: "Keep going · \(finishedAt.formatted(style))", locale: locale)
    }
    let time = completion.createdAt.formatted(style)
    // Web selects one of eight localized phrases from the last UTF-16 unit of the event ID.
    switch (completion.eventID.utf16.last ?? 0) % 8 {
    case 0: return String(localized: "Wrapped up at \(time)", locale: locale)
    case 1: return String(localized: "All done — \(time)", locale: locale)
    case 2: return String(localized: "Delivered at \(time)", locale: locale)
    case 3: return String(localized: "Finished at \(time), at your service", locale: locale)
    case 4: return String(localized: "That was a wrap — \(time)", locale: locale)
    case 5: return String(localized: "Mission complete, \(time)", locale: locale)
    case 6: return String(localized: "Signed off at \(time)", locale: locale)
    default: return String(localized: "Done and dusted — \(time)", locale: locale)
    }
  }
}
