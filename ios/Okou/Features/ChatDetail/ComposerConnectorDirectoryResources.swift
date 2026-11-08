import CCState
import ChatData
import Foundation

/// One Add connectors presentation owns its reads; query changes never create a keyed cache.
@MainActor
final class ComposerConnectorDirectoryResources {
  enum Tab: Equatable, Sendable { case discover, custom }

  struct Selection: Equatable, Sendable {
    var tab = Tab.discover
    var search = ""
    var category = ""
  }

  private struct Change {
    let tab: Tab?
    let search: String?
    let category: String?
  }

  private struct Filter: Equatable, Sendable {
    let search: String
    let category: String
  }

  let store = CCState.Store()
  let selection: Computed<Selection>
  private let input = CCState.State(Selection())
  private let lifetime = CCState.State(true)
  private let catalogRevision = CCState.State(0)
  private let customRevision = CCState.State(0)
  private let filter: Computed<Filter>
  private let keyword: Computed<String>
  private let select: Command<Void, Change>
  private let reload: Command<Void, Tab>
  private let service: ChatComposerAccess
  private let didFail: @MainActor (Error) -> Void
  private var catalogTask: Task<ChatConnectorDiscovery, Error>?
  private var customTask: Task<[ChatCustomConnector], Error>?
  private var closed = false

  init(service: ChatComposerAccess, didFail: @escaping @MainActor (Error) -> Void) {
    self.service = service
    self.didFail = didFail
    let input = input
    let catalogRevision = catalogRevision
    let customRevision = customRevision
    selection = Computed { get in try get(input) }
    filter = Computed { get in
      let value = try get(input)
      return Filter(search: value.search, category: value.category)
    }
    keyword = Computed { get in try get(input).search }
    select = Command { context, change in
      let previous = try context.get(input)
      var value = previous
      if let tab = change.tab { value.tab = tab }
      if let search = change.search { value.search = search }
      if let category = change.category { value.category = category }
      guard previous != value else { return }
      if previous.search != value.search || previous.category != value.category {
        try context.set(catalogRevision, update: { $0 + 1 })
      }
      try context.set(input, value)
    }
    reload = Command { context, tab in
      switch tab {
      case .discover: try context.set(catalogRevision, update: { $0 + 1 })
      case .custom: try context.set(customRevision, update: { $0 + 1 })
      }
    }
  }

  lazy var catalog = makeCatalog()

  private func makeCatalog() -> Computed<Task<ChatConnectorDiscovery, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      let filter = try get(filter)
      _ = try get(catalogRevision)
      let signal = options.signal
      let task = Task<ChatConnectorDiscovery, Error> { @MainActor [weak self, service] in
        do {
          try Task.checkCancellation()
          let result = try await service.discover(
            keyword: filter.search, category: filter.category.isEmpty ? nil : filter.category)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      catalogTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private lazy var custom = makeCustom()

  private func makeCustom() -> Computed<Task<[ChatCustomConnector], Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      _ = try get(customRevision)
      let signal = options.signal
      let task = Task<[ChatCustomConnector], Error> { @MainActor [weak self, service] in
        do {
          try Task.checkCancellation()
          let result = try await service.customConnectors()
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      customTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  lazy var customMatches = makeCustomMatches()

  private func makeCustomMatches() -> Computed<Task<[ChatCustomConnector], Error>> {
    computedTask { [custom, keyword] get, options in
      let search = try get(keyword)
      let pending = try get(custom)
      let values = try await pending.value
      try Task.checkCancellation()
      try options.signal.checkCancellation()
      return values.filter {
        search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search)
      }
    }
  }

  func update(tab: Tab? = nil, search: String? = nil, category: String? = nil) {
    guard !closed else { return }
    do {
      let previous = try store.get(selection)
      if search.map({ previous.search != $0 }) == true
        || category.map({ previous.category != $0 }) == true
      {
        catalogTask?.cancel()
      }
      try store.set(select, Change(tab: tab, search: search, category: category))
    } catch { didFail(error) }
  }

  func refresh() async {
    guard !closed, !Task.isCancelled else { return }
    do {
      let tab = try store.get(selection).tab
      try store.set(reload, tab)
      // The original Task keeps the read error for SwiftUI; refresh awaits its completion.
      switch tab {
      case .discover: _ = await (try store.get(catalog)).result
      case .custom: _ = await (try store.get(customMatches)).result
      }
    } catch { didFail(error) }
  }

  func close() {
    closed = true
    catalogTask?.cancel()
    customTask?.cancel()
    catalogTask = nil
    customTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    catalogTask?.cancel()
    customTask?.cancel()
  }
}
