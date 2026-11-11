import ChatData
import ChatDomain

/// Projects span Agents; only chats outside known Projects use the current Agent's scope.
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

  init(
    projects: [ChatProject], threads: [ChatThread], agentID: String?,
    filter: ChatListFilter
  ) {
    let knownIDs = Set(projects.map(\.id))
    let matches: (ChatThread) -> Bool = { thread in
      switch filter {
      case .unread: return !thread.isMuted && thread.indicator == .unread
      case .muted: return thread.isMuted
      case .recent: return !thread.isArchived
      case .archived: return thread.isArchived
      }
    }
    // Only the inbox leaves archived chats out, so only it offers them.
    let inbox = filter == .recent
    // Projects keep their creation order, oldest first, as the web replays them.
    let ordered = projects.sorted {
      ($0.createdAt, $0.id) < ($1.createdAt, $1.id)
    }
    self.projects = ordered.compactMap { project in
      let held = threads.filter { $0.projectId == project.id }
      let members = held.filter(matches)
      if members.isEmpty && !inbox { return nil }
      return ProjectGroup(
        project: project, threads: members,
        hasHiddenArchivedThreads: inbox && held.contains(where: \.isArchived))
    }
    // A name read can fail independently of membership synchronization. Keep
    // those authorized chats reachable while the Project read reports its error.
    let outside = threads.filter {
      $0.agentID == agentID && !knownIDs.contains($0.projectId ?? "")
    }
    self.threads = outside.filter(matches)
    hasHiddenArchivedThreads = inbox && outside.contains(where: \.isArchived)
  }
}
