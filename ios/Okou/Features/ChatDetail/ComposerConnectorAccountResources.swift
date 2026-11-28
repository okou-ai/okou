import CCState
import ChatData
import Foundation

/// A native account destination owns its reads and accumulated pages, never account writes.
@MainActor
final class ComposerConnectorAccountResources {
  enum Action: Sendable {
    case access(String, Bool?)
    case defaultAccount(String)
    case defaultEnabled(String, Bool)
    case policy(String, ChatConnectorAccountPolicyChoice)
    case rename(String, String?)
    case disconnect(String)
  }

  struct Page: Sendable {
    let accounts: [ChatConnectorAccount]
    let nextCursor: String?
    let access: ChatConnectorAccess
    let defaults: [ChatConnectorAccountDefault]
    let policies: [ChatConnectorAccountPolicy]?
  }

  private enum Controls: Sendable {
    case legacy([ChatConnectorAccountDefault])
    case member([ChatConnectorAccountPolicy])
  }

  /// Pagination accumulation is canonical returned data, not a second request phase.
  private struct Tail: Sendable {
    let accounts: [ChatConnectorAccount]
    let nextCursor: String?
  }

  let connector: ChatComposerConnector

  let managesDefaults: Bool
  /// The composer's Store, the workspace session's in production.
  let store: CCState.Store
  let search: Computed<String>
  let pagination: Computed<Task<Void, Error>>
  private let deletionID = CCState.State<String?>(nil)
  private let selectDeletion: Command<Void, String?>
  private let keyword = CCState.State("")
  private let revision = CCState.State(0)
  private let catalogRevision = CCState.State(0)
  private let reloadCatalog: Command<Void, Void>
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
  private weak var composer: ComposerConnectorStore?
  // All request phases remain in the resource Tasks.
  private(set) var isClosed = false
  /// Whether this page is still open, kept in the workspace session's Store. Native navigation
  /// resolves it, so retiring the page pops it.
  let openValue: Computed<Bool>
  /// `openValue` for a destination with no page.
  static let noPage = Computed { _ in false }
  private var generation = UUID()
  private var catalogTask: Task<ChatCatalogConnector, Error>?
  private var impactTask: Task<ChatConnectorDeletionImpact?, Error>?
  private var firstTask: Task<ChatConnectorAccounts, Error>?
  private var detailsTask: Task<Controls, Error>?
  private var moreTask: Task<Void, Error>?
  private var pinnedTask: Task<ChatConnectorAccount?, Error>?

  init(
    composer: ComposerConnectorStore, connector: ChatComposerConnector,
    managesDefaults: Bool, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.composer = composer
    self.connector = connector
    self.managesDefaults = managesDefaults
    store = composer.graph
    service = composer.service
    self.didFail = didFail
    let lifetime = lifetime
    openValue = Computed { try $0(lifetime) }
    let deletionID = deletionID
    selectDeletion = Command { context, value in try context.set(deletionID, value) }
    let catalogRevision = catalogRevision
    reloadCatalog = Command { context in
      try context.set(catalogRevision, update: { $0 + 1 })
    }
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

  lazy var catalog = makeCatalog()

  private func makeCatalog() -> Computed<Task<ChatCatalogConnector, Error>> {
    Computed { [weak self] get, options in
      guard let self, !isClosed, try get(lifetime), let slug = connector.target.connectorSlug
      else { throw CancellationError() }
      _ = try get(catalogRevision)
      let signal = options.signal
      let task = Task<ChatCatalogConnector, Error> { @MainActor [weak self, service] in
        do {
          let result = try await service.catalogConnector(slug: slug)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !isClosed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      catalogTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private lazy var first = makeFirst()

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

  private lazy var details = makeDetails()

  private func makeDetails() -> Computed<Task<Controls, Error>> {
    Computed { [weak self] get, options in
      guard let self, !isClosed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      _ = try get(contextRevision)
      let signal = options.signal
      let target = connector.target
      let memberAccess = composer?.usesMemberAccess == true
      let task: Task<Controls, Error> =
        Task { @MainActor [weak self, service] in
          do {
            try Task.checkCancellation()
            let controls: Controls
            if memberAccess {
              controls = .member(try await service.accountPolicies(target: target))
            } else {
              controls = .legacy(try await service.accountDefaults(target: target))
            }
            try Task.checkCancellation()
            try signal.checkCancellation()
            return controls
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

  lazy var page = makePage()

  private func makePage() -> Computed<Task<Page, Error>> {
    computedTask { [weak self] get, options in
      guard let self, !isClosed, let composer, try get(lifetime) else {
        throw CancellationError()
      }
      _ = try get(contextRevision)
      let search = try get(keyword)
      let tail = try get(tail)
      let first = try get(first)
      let memberAccess = composer.usesMemberAccess
      let details = managesDefaults || memberAccess ? try get(details) : nil
      let current = composer.connectors.first(where: { $0.target == connector.target })
      guard managesDefaults || current != nil else {
        throw APIClientError.http(status: 404, message: "Connector unavailable.")
      }
      let (result, controls) = try await (first.value, details?.value)
      try Task.checkCancellation()
      try options.signal.checkCancellation()
      guard !isClosed else { throw CancellationError() }
      var accounts = result.connections + (tail?.accounts ?? [])
      if !managesDefaults, search.isEmpty, let id = current?.access.currentConnectionId,
        !accounts.contains(where: { $0.id == id })
      {
        // Keep the selected account visible even when it falls outside the loaded pages.
        let pinned: ChatConnectorAccount?
        if result.defaultConnection?.id == id {
          pinned = result.defaultConnection
        } else {
          pinned = try await readPinnedAccount(
            id, service: composer.authorizationService, signal: options.signal
          ).value
          try Task.checkCancellation()
          try options.signal.checkCancellation()
        }
        if let pinned { accounts.insert(pinned, at: 0) }
      }
      let cursor: String?
      if let tail { cursor = tail.nextCursor } else { cursor = result.nextCursor }
      let access: ChatConnectorAccess
      if let current {
        access = current.access
      } else {
        access = try await service.connectorAccess(
          target: connector.target, threadID: nil, memberAccess: memberAccess)
        try Task.checkCancellation()
        try options.signal.checkCancellation()
      }
      let defaults: [ChatConnectorAccountDefault]
      let policies: [ChatConnectorAccountPolicy]?
      switch controls {
      case .member(let value):
        policies = value
        defaults = []
      case .legacy(let value):
        policies = nil
        defaults = value
      case nil:
        policies = nil
        defaults = []
      }
      return Page(
        accounts: accounts, nextCursor: cursor, access: access, defaults: defaults,
        policies: policies)
    }
  }

  private func readPinnedAccount(
    _ id: String, service: ChatConnectorService, signal: EvaluationSignal
  ) -> Task<ChatConnectorAccount?, Error> {
    let target = connector.target
    let task = Task<ChatConnectorAccount?, Error> {
      do {
        return try await service.account(id: id, target: target)
      } catch let error as APIClientError where error.statusCode == 404 {
        // The account was removed after the overview was read.
        return nil
      }
    }
    pinnedTask = task
    signal.onCancel { task.cancel() }
    return task
  }

  lazy var deletionImpact = makeDeletionImpact()

  private func makeDeletionImpact() -> Computed<Task<ChatConnectorDeletionImpact?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !isClosed, try get(lifetime) else { throw CancellationError() }
      let id = try get(deletionID)
      let target = connector.target
      let signal = options.signal
      let task = Task<ChatConnectorDeletionImpact?, Error> { @MainActor [weak self, service] in
        do {
          guard let id else { return nil }
          let result = try await service.deletionImpact(target: target, connectionID: id)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !isClosed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      impactTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func prepareDisconnect(_ id: String?) {
    guard !isClosed else { return }
    do { try store.set(selectDeletion, id) } catch { didFail(error) }
  }

  func retryCatalog() {
    guard !isClosed else { return }
    do { try store.set(reloadCatalog) } catch { didFail(error) }
  }

  func update(search: String) {
    guard !isClosed else { return }
    do {
      guard try store.get(keyword) != search else { return }
      generation = UUID()
      firstTask?.cancel()
      moreTask?.cancel()
      moreTask = nil
      pinnedTask?.cancel()
      try store.set(changeSearch, search)
    } catch { didFail(error) }
  }

  func reconcile() {
    guard !isClosed else { return }
    pinnedTask?.cancel()
    do { try store.set(contextChanged) } catch { didFail(error) }
  }

  func refresh() async {
    guard !isClosed, !Task.isCancelled else { return }
    generation = UUID()
    firstTask?.cancel()
    detailsTask?.cancel()
    pinnedTask?.cancel()
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
    catalogTask?.cancel()
    impactTask?.cancel()
    firstTask?.cancel()
    detailsTask?.cancel()
    pinnedTask?.cancel()
    moreTask?.cancel()
    catalogTask = nil
    impactTask = nil
    firstTask = nil
    detailsTask = nil
    pinnedTask = nil
    moreTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
    composer?.retireAccounts(self)
  }

  isolated deinit {
    catalogTask?.cancel()
    impactTask?.cancel()
    firstTask?.cancel()
    detailsTask?.cancel()
    pinnedTask?.cancel()
    moreTask?.cancel()
  }
}
