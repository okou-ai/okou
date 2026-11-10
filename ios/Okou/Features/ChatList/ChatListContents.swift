import ChatData
import ChatDomain

/// The workspace's single semantic selection; native controls supply labels and icons.
enum ChatListFilter: CaseIterable {
  case recent, unread, archived, muted
}

/// Projects span Agents; only chats outside known Projects use the current Agent's scope.
struct ChatListContents: Equatable {
  enum Marker: Equatable {
    case none, running, unread, pinned
  }

  struct Row: Identifiable, Equatable {
    let thread: ChatThread
    let marker: Marker
    var id: String { thread.id }

    init(_ thread: ChatThread) {
      self.thread = thread
      if thread.indicator == .active {
        marker = .running
      } else if !thread.isMuted && thread.indicator == .unread {
        marker = .unread
      } else if thread.pinnedAt != nil {
        marker = .pinned
      } else {
        marker = .none
      }
    }
  }

  struct ProjectGroup: Identifiable, Equatable {
    let project: ChatProject
    let threads: [Row]
    let marker: Marker
    var id: String { project.id }
  }

  let projects: [ProjectGroup]
  let threads: [Row]

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
      let members = threads.filter { $0.projectId == project.id && matches($0) }.map(Row.init)
      if members.isEmpty && filter != .recent { return nil }
      let marker: Marker
      if members.contains(where: { $0.marker == .running }) {
        marker = .running
      } else if members.contains(where: { $0.marker == .unread }) {
        marker = .unread
      } else {
        marker = .none
      }
      return ProjectGroup(project: project, threads: members, marker: marker)
    }
    // A name read can fail independently of membership synchronization. Keep
    // those authorized chats reachable while the Project read reports its error.
    self.threads = threads.filter {
      $0.agentID == agentID && !knownIDs.contains($0.projectId ?? "") && matches($0)
    }.map(Row.init)
  }
}
