import ChatData
import ChatDomain
import Foundation
import OSLog
import Observation
import WidgetKit

/// Publishes the widget snapshot from the workspace's confirmed chat list. The value is derived
/// from the list on each render; the owning view writes it only when it changes.
enum OkouWidgetPublishing {
  static let kind = OkouWidgetSnapshot.widgetKind
  private static let log = Logger(subsystem: "ai.okou.ios", category: "widgets")

  static func snapshot(
    userID: String, workspaceID: String, threads: [ChatThread], name: String?,
    hasDraft: (String) -> Bool
  ) -> OkouWidgetSnapshot {
    var chats: [OkouWidgetSnapshot.Chat] = []
    for thread in threads where !thread.isArchived && !thread.isHidden {
      let parts = thread.titleParts
      var state = OkouWidgetSnapshot.Chat.State.idle
      if thread.indicator == .active {
        state = .working
      } else if !thread.isMuted && thread.indicator == .unread {
        state = .finished
      } else if hasDraft(thread.id) {
        state = .draft
      }
      chats.append(
        OkouWidgetSnapshot.Chat(
          id: thread.id, title: parts.text, emoji: parts.emoji, state: state,
          isPinned: thread.pinnedAt != nil, activityAt: thread.sortAt))
    }
    // The snapshot orders and bounds its chats the same way the widget's own refresh does.
    return OkouWidgetSnapshot(
      userID: userID, workspaceID: workspaceID, greetings: greetings(name: name), chats: chats)
  }

  /// The new-chat taglines that suit each part of the day.
  private static func greetings(name: String?) -> OkouWidgetSnapshot.Greetings {
    guard let name, !name.isEmpty else {
      return OkouWidgetSnapshot.Greetings(
        morning: NewChatTagline.text(index: 0, name: nil),
        day: NewChatTagline.text(index: 1, name: nil),
        evening: NewChatTagline.text(index: 2, name: nil),
        night: NewChatTagline.text(index: 4, name: nil))
    }
    return OkouWidgetSnapshot.Greetings(
      morning: NewChatTagline.text(index: 9, name: name),
      day: NewChatTagline.text(index: 1, name: name),
      evening: NewChatTagline.text(index: 4, name: name),
      night: NewChatTagline.text(index: 7, name: name))
  }

  static func publish(_ snapshot: OkouWidgetSnapshot) {
    guard let store = OkouWidgetSnapshotStore() else { return }
    do {
      try store.write(snapshot)
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    } catch {
      log.error("Cannot write the widget snapshot: \(error.localizedDescription, privacy: .public)")
    }
  }

  static func clear() {
    guard let store = OkouWidgetSnapshotStore() else { return }
    do {
      try store.clear()
      WidgetCenter.shared.reloadTimelines(ofKind: kind)
    } catch {
      log.error("Cannot clear the widget snapshot: \(error.localizedDescription, privacy: .public)")
    }
  }
}

/// Links from a widget or control: `ai.okou.ios://widget/new`, `…/voice` and
/// `…/chat/<thread id>?workspace=<id>`. New chat and voice reuse the system entry points; a
/// chat waits for its workspace's root to open it.
@MainActor @Observable
final class OkouWidgetLinks {
  static let shared = OkouWidgetLinks()
  private(set) var requestID: UUID?
  private var pending: (threadID: String, workspaceID: String)?

  /// Returns whether the URL was a widget link.
  func receive(_ url: URL) -> Bool {
    guard url.scheme == Bundle.main.bundleIdentifier, url.host == "widget" else { return false }
    let path = url.pathComponents.filter { $0 != "/" }
    switch path.first {
    case "new":
      NewChatRequests.shared.request()
    case "voice":
      NewChatRequests.shared.request(startVoiceInput: true)
    case "chat":
      let workspace = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .first { $0.name == "workspace" }?.value
      if path.count == 2, UUID(uuidString: path[1]) != nil, let workspace {
        pending = (path[1], workspace)
        requestID = UUID()
      }
    default:
      break
    }
    return true
  }

  /// The chat to open in this workspace, consumed once.
  func takeChat(in workspaceID: String) -> String? {
    guard let pending, pending.workspaceID == workspaceID else { return nil }
    self.pending = nil
    return pending.threadID
  }
}
