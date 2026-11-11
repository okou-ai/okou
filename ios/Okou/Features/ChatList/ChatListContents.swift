import ChatData
import ChatDomain

/// Projects span Agents; only chats outside known Projects use the current Agent's scope.
struct ChatListContents {
  struct ProjectGroup: Identifiable {
    let project: ChatProject
    let threads: [ChatThread]
    var id: String { project.id }
  }

  let projects: [ProjectGroup]
  let threads: [ChatThread]

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
    self.projects = projects.compactMap { project in
      let members = threads.filter { $0.projectId == project.id && matches($0) }
      if members.isEmpty && filter != .recent { return nil }
      return ProjectGroup(project: project, threads: members)
    }
    // A name read can fail independently of membership synchronization. Keep
    // those authorized chats reachable while the Project read reports its error.
    self.threads = threads.filter {
      $0.agentID == agentID && !knownIDs.contains($0.projectId ?? "") && matches($0)
    }
  }
}
