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
    var id: String { thread.id }

    init(_ thread: ChatThread) {
      self.thread = thread
      let parts = thread.titleParts
      title = parts.text
      emoji = parts.emoji
      isWorking = thread.indicator == .active
      isUnread = !thread.isMuted && thread.indicator == .unread
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
    var id: String { project.id }
  }

  let filter: ChatListFilter
  let pinned: Section
  let chats: Section
  let projects: [ProjectGroup]
  var isEmpty: Bool { pinned.isEmpty && chats.isEmpty && projects.isEmpty }
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
        pinned: .init(contents.threads.filter { $0.pinnedAt != nil }),
        chats: .init(contents.threads.filter { $0.pinnedAt == nil }),
        projects: contents.projects.map { .init(project: $0.project, section: .init($0.threads)) })
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
