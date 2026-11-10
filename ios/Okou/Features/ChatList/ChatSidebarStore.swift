import CCState
import ChatData
import ChatDomain
import Observation

/// Semantic sidebar state for one workspace. Native menus, disclosure and scrolling stay native.
@MainActor @Observable
final class ChatSidebarStore {
  private let store: CCState.Store
  private let selectedFilter = CCState.State(ChatListFilter.recent)
  private let selectedAgent = CCState.State<String?>(nil)
  private let closed = CCState.State(false)
  private let filterValue: Computed<ChatListFilter>
  let contentsValue: Computed<ChatListContents>
  private let searchThreadsValue: Computed<[ChatThread]>
  private let transition: Command<Void, Action>
  private var subscriptions: [Subscription] = []

  private enum Action {
    case selectFilter(ChatListFilter)
    case selectAgent(String?)
    case close
  }

  init(
    store: CCState.Store, threads: Signal<[ChatThread]>, projects: Signal<[ChatProject]>
  ) {
    self.store = store
    let selectedFilter = selectedFilter
    let selectedAgent = selectedAgent
    let closed = closed
    filterValue = Computed { get in try get(selectedFilter) }
    contentsValue = Computed { get in
      try ChatListContents(
        projects: get(projects), threads: get(threads), agentID: get(selectedAgent),
        filter: get(selectedFilter))
    }
    searchThreadsValue = Computed { get in
      let filter = try get(selectedFilter)
      let agent = try get(selectedAgent)
      // Empty-query search historically scopes to the Agent, with Unread crossing archive
      // state. Muted still opens recent search; a typed query searches every chat.
      return try get(threads).filter {
        guard $0.agentID == agent else { return false }
        if filter == .unread { return !$0.isMuted && $0.indicator == .unread }
        return $0.isArchived == (filter == .archived)
      }
    }
    transition = Command { context, action in
      guard try !context.get(closed) else { return }
      switch action {
      case .selectFilter(let filter):
        if try context.get(selectedFilter) != filter { try context.set(selectedFilter, filter) }
      case .selectAgent(let agent):
        if try context.get(selectedAgent) != agent { try context.set(selectedAgent, agent) }
      case .close:
        try context.set(closed, true)
      }
    }
    do {
      subscriptions.append(
        try store.watch(filterValue) { [weak self] in
          self?.withMutation(keyPath: \.filter) {}
        })
      subscriptions.append(
        try store.watch(contentsValue) { [weak self] in
          self?.withMutation(keyPath: \.contents) {}
        })
      subscriptions.append(
        try store.watch(searchThreadsValue) { [weak self] in
          self?.withMutation(keyPath: \.recentSearchThreads) {}
        })
    } catch { preconditionFailure("Cannot observe the local sidebar graph: \(error)") }
  }

  var filter: ChatListFilter {
    access(keyPath: \.filter)
    return read(filterValue)
  }

  var contents: ChatListContents {
    access(keyPath: \.contents)
    return read(contentsValue)
  }

  var recentSearchThreads: [ChatThread] {
    access(keyPath: \.recentSearchThreads)
    return read(searchThreadsValue)
  }

  func selectFilter(_ filter: ChatListFilter) { perform(.selectFilter(filter)) }
  func selectAgent(_ agent: String?) { perform(.selectAgent(agent)) }

  func close() {
    perform(.close)
    stopObserving()
  }

  private func stopObserving() {
    for subscription in subscriptions {
      do { try subscription.cancel() } catch {
        preconditionFailure("Cannot release the local sidebar graph: \(error)")
      }
    }
    subscriptions = []
  }

  private func perform(_ action: Action) {
    do { try store.set(transition, action) } catch {
      preconditionFailure("Cannot update the local sidebar graph: \(error)")
    }
  }

  private func read<Value>(_ signal: Signal<Value>) -> Value {
    // These inputs and derivations are synchronous and non-failing. The graph does not
    // read HTTP Tasks or replace the resource owners' loading/error or confirmed writes.
    do { return try store.get(signal) } catch {
      preconditionFailure("Cannot read the local sidebar graph: \(error)")
    }
  }

  isolated deinit { stopObserving() }
}
