import ChatDomain
import Foundation

extension ThreadListStore {
  struct RenameRequest: Identifiable {
    let id: UUID
    let threadID: String
    var error: String?
  }

  var hasUnreadThreads: Bool {
    threads.contains { !$0.isMuted && !$0.isArchived && $0.indicator == .unread }
  }

  var error: String? { actionError ?? syncError }

  func threads(archived: Bool, onlyUnread: Bool = false) -> [ChatThread] {
    threads.filter {
      if onlyUnread {
        // PWA's unread list includes archived chats and retains active-indicator precedence.
        return !$0.isMuted && $0.indicator == .unread
      }
      return $0.isArchived == archived
    }
  }

  func canMute(_ id: String) -> Bool {
    canUpdate(id)
  }

  func togglePinned(_ id: String) async {
    guard let thread = threads.first(where: { $0.id == id }) else { return }
    await setPinned(thread, pinned: thread.pinnedAt == nil)
  }
}
