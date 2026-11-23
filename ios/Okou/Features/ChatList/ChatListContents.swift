import ChatData
import ChatDomain

/// Groups a member's chats by Project and keeps ungrouped chats in the inbox.
struct ChatListContents {
  struct ProjectGroup: Identifiable {
    let project: ChatProject
    let threads: [ChatThread]
    /// The inbox leaves out archived chats this Project holds.
    let hasHiddenArchivedThreads: Bool
    var id: String { project.id }
  }

  let projects: [ProjectGroup]
  let threads: [ChatThread]
  /// The inbox leaves out archived chats outside Projects.
  let hasHiddenArchivedThreads: Bool

  static func hasUnreadThreads(projects: [ChatProject], threads: [ChatThread]) -> Bool {
    let byID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    return threads.contains { thread in
      isUnread(thread) && !thread.isArchived
        && projectAllowsUnread(thread, thread.projectId.flatMap { byID[$0] })
    }
  }

  private static func isUnread(_ thread: ChatThread) -> Bool {
    !thread.isMuted && thread.indicator == .unread
  }

  private static func projectAllowsUnread(_ thread: ChatThread, _ project: ChatProject?) -> Bool {
    if project?.isArchived == true { return false }
    guard let cutoff = project?.lastArchivedAt else { return true }
    return thread.unreadAt.map { $0 > cutoff } ?? false
  }

  init(
    projects: [ChatProject], threads: [ChatThread],
    filter: ChatListFilter
  ) {
    let knownIDs = Set(projects.map(\.id))
    let matches: (ChatThread) -> Bool = { thread in
      switch filter {
      case .unread: return Self.isUnread(thread)
      case .muted: return thread.isMuted
      case .recent: return !thread.isArchived
      case .archived: return thread.isArchived
      }
    }
    // Only the inbox leaves archived chats out, so only it offers them.
    let inbox = filter == .recent
    let ordered = projects.sorted(by: ChatProject.isOrderedBefore)
    self.projects = ordered.compactMap { project in
      let held = threads.filter { $0.projectId == project.id }
      if project.isArchived && (inbox || filter == .unread) { return nil }
      let showWholeProject = filter == .archived && project.isArchived
      let members =
        showWholeProject
        ? held
        : held.filter { thread in
          matches(thread) && (filter != .unread || Self.projectAllowsUnread(thread, project))
        }
      if members.isEmpty && !inbox && !showWholeProject { return nil }
      return ProjectGroup(
        project: project, threads: members,
        hasHiddenArchivedThreads: inbox && held.contains(where: \.isArchived))
    }
    // A name read can fail independently of membership synchronization. Keep
    // those authorized chats reachable while the Project read reports its error.
    let outside = threads.filter {
      !knownIDs.contains($0.projectId ?? "")
    }
    self.threads = outside.filter(matches)
    hasHiddenArchivedThreads =
      inbox && (outside.contains(where: \.isArchived) || projects.contains(where: \.isArchived))
  }
}
