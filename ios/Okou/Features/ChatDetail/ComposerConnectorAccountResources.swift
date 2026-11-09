import CCState
import ChatData
import Foundation
import Observation

/// A native account destination owns its reads and accumulated pages, never account writes.
@MainActor @Observable
final class ComposerConnectorAccountResources {
  enum Action: Sendable {
    case select(String?)
    case access(String, Bool?)
    case defaultAccount(String)
    case defaultEnabled(String, Bool)
  }

  struct Page: Sendable {
    let accounts: [ChatConnectorAccount]
    let nextCursor: String?
    let defaultAccount: ChatConnectorAccount?
    let selectedID: String?
    let access: ChatConnectorAccess?
    let defaults: [ChatConnectorAccountDefault]
  }

  private struct Details: Sendable {
    var preferences: ChatConnectorPreferences?
    var defaults: [ChatConnectorAccountDefault] = []
  }

  /// Pagination accumulation is canonical returned data, not a second request phase.
  private struct Tail: Sendable {
    let accounts: [ChatConnectorAccount]
    let nextCursor: String?
  }

  let connector: ChatComposerConnector
  let agentID: String
  let chatAccountAccess: Bool
  let managesDefaults: Bool
  let store = CCState.Store()
  let search: Computed<String>
  let pagination: Computed<Task<Void, Error>>
  private let keyword = CCState.State("")
  private let revision = CCState.State(0)
  private let contextRevision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let tail = CCState.State<Tail?>(nil)
  private let more = CCState.State(Task<Void, Error> {})
  private let changeSearch: Command<Void, String>
  private let reload: Command<Void, Void>
  private let contextChanged: Command<Void, Void>
  private let append: Command<Void, Tail>
  private let setPagination: Command<Void, Task<Void, Error>>
  private let service: ChatComposerAccess
  private let didFail: @MainActor (Error) -> Void
  @ObservationIgnored private weak var composer: ComposerConnectorStore?
  // Native navigation observes retirement; all request phases remain in the resource Tasks.
  private(set) var isClosed = false
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var firstTask: Task<ChatConnectorAccounts, Error>?
  @ObservationIgnored private var detailsTask: Task<Details, Error>?
  @ObservationIgnored private var moreTask: Task<Void, Error>?

  init(
    composer: ComposerConnectorStore, connector: ChatComposerConnector, agentID: String,
    managesDefaults: Bool, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.composer = composer
    self.connector = connector
    self.agentID = agentID
    self.managesDefaults = managesDefaults
    chatAccountAccess = composer.chatAccountAccess
    service = composer.service
    self.didFail = didFail
    let keyword = keyword
    let revision = revision
    let contextRevision = contextRevision
    let tail = tail
    let more = more
    search = Computed { get in try get(keyword) }
    pagination = Computed { get in try get(more) }
    changeSearch = Command { context, value in
      try context.set(tail, nil)
      try context.set(keyword, value)
      try context.set(more, Task<Void, Error> {})
    }
    reload = Command { context in
      try context.set(tail, nil)
      try context.set(revision, update: { $0 + 1 })
      try context.set(more, Task<Void, Error> {})
    }
    contextChanged = Command { context in
      try context.set(contextRevision, update: { $0 + 1 })
    }
    append = Command { context, value in try context.set(tail, value) }
    setPagination = Command { context, value in try context.set(more, value) }
  }

  @ObservationIgnored private lazy var first = makeFirst()

  private func makeFirst() -> Computed<Task<ChatConnectorAccounts, Error>> {
    Computed { [weak self] get, options in
      guard let self, !isClosed, try get(lifetime) else { throw CancellationError() }
      let search = try get(keyword)
      _ = try get(revision)
      let signal = options.signal
      let target = connector.target
      let task = Task<ChatConnectorAccounts, Error> { @MainActor [weak self, service] in
        do {
          try Task.checkCancellation()
          let result = try await service.accounts(target: target, search: search)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !isClosed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      firstTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  @ObservationIgnored private lazy var details = makeDetails()

  private func makeDetails() -> Computed<Task<Details, Error>> {
    Computed { [weak self] get, options in
      guard let self, !isClosed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let target = connector.target
      let threadID = composer?.threadID
      let task = Task<Details, Error> {
        @MainActor [weak self, service, managesDefaults, chatAccountAccess] in
        do {
          try Task.checkCancellation()
          var value = Details()
          if managesDefaults {
            value.defaults = try await service.accountDefaults(target: target)
          } else if !chatAccountAccess, let threadID {
            value.preferences = try await service.preferences(threadID: threadID)
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          return value
        } catch {
          if let self, !isClosed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      detailsTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  @ObservationIgnored lazy var page = makePage()

  private func makePage() -> Computed<Task<Page, Error>> {
    computedTask { [weak self] get, options in
      guard let self, !isClosed, let composer, try get(lifetime) else {
        throw CancellationError()
      }
      _ = try get(contextRevision)
      let search = try get(keyword)
      let tail = try get(tail)
      let first = try get(first)
      let details = try get(details)
      guard let current = composer.connectors.first(where: { $0.target == connector.target }) else {
        throw APIClientError.http(status: 404, message: "Connector unavailable.")
      }
      let pending = composer.pendingOptions.connectorSelections.first {
        $0.target == connector.target
      }
      let (result, settings) = try await (first.value, details.value)
      try Task.checkCancellation()
      try options.signal.checkCancellation()
      var accounts = result.connections + (tail?.accounts ?? [])
      let selected = settings.preferences?.selections.first { $0.target == connector.target }
      let selectedID =
        chatAccountAccess
        ? current.access?.currentConnectionId
        : (settings.preferences == nil ? pending?.connectionId : selected?.connectionId)
      let explicit = settings.preferences?.selectedConnections.first { $0.id == selectedID }
      let pinned = chatAccountAccess ? (search.isEmpty ? current.currentAccount : nil) : explicit
      if !managesDefaults, let pinned, !accounts.contains(where: { $0.id == pinned.id }) {
        accounts.insert(pinned, at: 0)
      }
      let cursor: String?
      if let tail { cursor = tail.nextCursor } else { cursor = result.nextCursor }
      return Page(
        accounts: accounts, nextCursor: cursor,
        defaultAccount: result.defaultConnection, selectedID: selectedID, access: current.access,
        defaults: settings.defaults)
    }
  }

  func update(search: String) {
    guard !isClosed else { return }
    do {
      guard try store.get(keyword) != search else { return }
      generation = UUID()
      firstTask?.cancel()
      moreTask?.cancel()
      moreTask = nil
      try store.set(changeSearch, search)
    } catch { didFail(error) }
  }

  func reconcile() {
    guard !isClosed else { return }
    do { try store.set(contextChanged) } catch { didFail(error) }
  }

  func refresh() async {
    guard !isClosed, !Task.isCancelled else { return }
    generation = UUID()
    firstTask?.cancel()
    detailsTask?.cancel()
    moreTask?.cancel()
    moreTask = nil
    do {
      try store.set(reload)
      _ = await (try store.get(page)).result
    } catch { didFail(error) }
  }

  func retry() async {
    guard !isClosed, let composer else { return }
    await composer.refresh()
    await refresh()
  }

  func loadMore() async {
    guard !isClosed, !Task.isCancelled else { return }
    if let moreTask {
      _ = await moreTask.result
      return
    }
    let request = generation
    do {
      let value = try await store.get(page).value
      guard !isClosed, !Task.isCancelled, request == generation, moreTask == nil,
        let cursor = value.nextCursor
      else { return }
      let search = try store.get(keyword)
      let previous = try store.get(tail)?.accounts ?? []
      let base = try await store.get(first).value
      guard !isClosed, !Task.isCancelled, request == generation else { return }
      let existing = Set((base.connections + previous).map(\.id))
      let target = connector.target
      let task = Task<Void, Error> { @MainActor [weak self, service] in
        do {
          try Task.checkCancellation()
          let result = try await service.accounts(target: target, search: search, cursor: cursor)
          try Task.checkCancellation()
          guard let self, !isClosed, request == generation else { throw CancellationError() }
          try store.set(
            append,
            Tail(
              accounts: previous + result.connections.filter { !existing.contains($0.id) },
              nextCursor: result.nextCursor))
        } catch {
          if let self, !isClosed, !Task.isCancelled, request == generation { didFail(error) }
          throw error
        }
      }
      moreTask = task
      try store.set(setPagination, task)
      _ = await task.result
      if request == generation { moreTask = nil }
    } catch { if !isClosed, !Task.isCancelled { didFail(error) } }
  }

  func apply(_ action: Action) async {
    guard !isClosed, !Task.isCancelled, let composer else { return }
    await composer.applyAccountAction(owner: self, action: action)
  }

  func close() {
    guard !isClosed else { return }
    isClosed = true
    generation = UUID()
    firstTask?.cancel()
    detailsTask?.cancel()
    moreTask?.cancel()
    firstTask = nil
    detailsTask = nil
    moreTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
    composer?.retireAccounts(self)
  }

  isolated deinit {
    firstTask?.cancel()
    detailsTask?.cancel()
    moreTask?.cancel()
  }
}
