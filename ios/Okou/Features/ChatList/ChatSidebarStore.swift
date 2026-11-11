import CCState
import ChatData
import ChatDomain
import Foundation

enum ChatListFilter: CaseIterable, Equatable, Sendable {
  case recent, unread, archived, muted
}

/// Pure presentation over the business owners' original confirmed inputs.
struct ChatSidebarPresentation {
  struct Row: Identifiable {
    let thread: ChatThread
    let title: String
    let emoji: String?
    let isWorking: Bool
    let isUnread: Bool
    let isPinned: Bool
    var id: String { thread.id }

    init(_ thread: ChatThread) {
      self.thread = thread
      let parts = thread.titleParts
      title = parts.text
      emoji = parts.emoji
      isWorking = thread.indicator == .active
      isUnread = !thread.isMuted && thread.indicator == .unread
      isPinned = thread.pinnedAt != nil
    }
  }

  struct Section {
    let rows: [Row]
    let showsStatusColumn: Bool
    let isWorking: Bool
    let hasUnread: Bool
    var isEmpty: Bool { rows.isEmpty }

    init(_ threads: [ChatThread]) {
      rows = threads.map(Row.init)
      showsStatusColumn = rows.contains { $0.emoji != nil }
      isWorking = rows.contains(where: \.isWorking)
      hasUnread = rows.contains(where: \.isUnread)
    }
  }

  struct ProjectGroup: Identifiable {
    let project: ChatProject
    let section: Section
    /// The inbox leaves out archived chats this project holds; an empty project offers them.
    var hasHiddenArchivedChats = false
    var id: String { project.id }
  }

  /// The pinned chats a Move up / Move down places a pinned chat beside, in the list that
  /// shows them: a project (`projectID`), or the chats outside projects (nil).
  struct PinNeighbors: Equatable {
    let above: String?
    let below: String?
    var projectID: String?
  }

  let filter: ChatListFilter
  /// Projects oldest first, each with its pins (in their manual order) before its other chats.
  let projects: [ProjectGroup]
  /// Chats outside Projects: pins in their manual order, then the most recent activity first.
  let chats: Section
  /// The inbox leaves out archived chats outside projects; an empty inbox offers them.
  let hasHiddenArchivedChats: Bool
  var isEmpty: Bool { chats.isEmpty && projects.isEmpty }
  /// The inbox is the default list; every other filter offers the way back to it.
  var isInbox: Bool { filter == .recent }
  /// Each list's pins reorder among themselves, and only in the inbox, as on the web.
  private let reorderablePins: [(projectID: String?, ids: [String])]

  init(
    filter: ChatListFilter, projects: [ProjectGroup], chats: Section,
    hasHiddenArchivedChats: Bool = false
  ) {
    self.filter = filter
    self.projects = projects
    self.chats = chats
    self.hasHiddenArchivedChats = hasHiddenArchivedChats
    let pins = { (section: Section) in section.rows.filter(\.isPinned).map(\.id) }
    reorderablePins =
      filter == .recent
      ? [(nil, pins(chats))] + projects.map { ($0.id, pins($0.section)) } : []
  }

  func pinNeighbors(of id: String) -> PinNeighbors? {
    for list in reorderablePins {
      guard let index = list.ids.firstIndex(of: id) else { continue }
      return PinNeighbors(
        above: index > 0 ? list.ids[index - 1] : nil,
        below: index + 1 < list.ids.count ? list.ids[index + 1] : nil,
        projectID: list.projectID)
    }
    return nil
  }
}

/// One filter per workspace; no copied request phase, confirmed list or draft document.
@MainActor
final class ChatSidebarStore {
  let stateStore: CCState.Store
  private let selection = CCState.State(ChatListFilter.recent)
  private let lifetime = CCState.State(true)
  private let selectFilter: Command<Void, ChatListFilter>
  private let retire: Command<Void, Void>
  let contents: Computed<ChatListContents>
  let presentation: Computed<ChatSidebarPresentation>

  init(
    store: CCState.Store, threads: Signal<[ChatThread]>, agents: Signal<[AgentRecord]>,
    projects: Signal<[ChatProject]>, selectedThread: Signal<String?>
  ) {
    stateStore = store
    let selection = selection
    let lifetime = lifetime
    selectFilter = Command { context, value in
      guard try context.get(lifetime), try context.get(selection) != value else { return }
      try context.set(selection, value)
    }
    retire = Command { context in
      guard try context.get(lifetime) else { return }
      try context.set(lifetime, false)
    }
    let contents = Computed<ChatListContents> { get in
      guard try get(lifetime) else { throw CancellationError() }
      let threads = try get(threads)
      let selected = try get(selectedThread)
      let agentID: String?
      if let selectedAgent = threads.first(where: { $0.id == selected })?.agentID {
        agentID = selectedAgent
      } else {
        agentID = try get(agents).first(where: \.isDefaultAgent)?.agentId
      }
      return try ChatListContents(
        projects: get(projects), threads: threads, agentID: agentID, filter: get(selection))
    }
    self.contents = contents
    presentation = Computed { get in
      let contents = try get(contents)
      return try ChatSidebarPresentation(
        filter: get(selection),
        projects: contents.projects.map {
          .init(
            project: $0.project, section: .init($0.threads),
            hasHiddenArchivedChats: $0.hasHiddenArchivedThreads)
        },
        chats: .init(contents.threads), hasHiddenArchivedChats: contents.hasHiddenArchivedThreads)
    }
  }

  var filter: ChatListFilter {
    do { return try stateStore.get(selection) } catch {
      preconditionFailure("Cannot read the local sidebar filter: \(error)")
    }
  }

  func select(_ filter: ChatListFilter) {
    do { try stateStore.set(selectFilter, filter) } catch {
      preconditionFailure("Cannot select the local sidebar filter: \(error)")
    }
  }

  func close() {
    do { try stateStore.set(retire) } catch {
      preconditionFailure("Cannot retire the local sidebar graph: \(error)")
    }
  }
}
