import CCState
import ChatData
import Foundation

/// One Add connectors presentation owns its reads; query changes never create a keyed cache.
@MainActor
final class ComposerConnectorDirectoryResources {
  struct Selection: Equatable, Sendable {
    var search = ""
    var category = ""
  }

  /// The workspace session's Store, which keeps the directory's graph values.
  let store: CCState.Store
  let selection: Computed<Selection>
  private let input = CCState.State(Selection())
  private let lifetime = CCState.State(true)
  private let catalogRevision = CCState.State(0)
  private let select: Command<Void, Selection>
  private let reload: Command<Void, Void>
  private let service: ChatComposerAccess
  private let didFail: @MainActor (Error) -> Void
  private var catalogTask: Task<ChatConnectorDiscovery, Error>?
  private var closed = false

  init(
    service: ChatComposerAccess, graph: CCState.Store,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    store = graph
    self.didFail = didFail
    let input = input
    let catalogRevision = catalogRevision
    selection = Computed { get in try get(input) }
    let reload = Command<Void, Void> { context in
      try context.set(catalogRevision, update: { $0 + 1 })
    }
    self.reload = reload
    select = Command { context, value in
      try context.set(input, value)
      // A rapid round trip to an earlier filter still needs a fresh task.
      try context.set(reload)
    }
  }

  lazy var catalog = makeCatalog()

  private func makeCatalog() -> Computed<Task<ChatConnectorDiscovery, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      let filter = try get(selection)
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

  func update(search: String? = nil, category: String? = nil) {
    guard !closed else { return }
    do {
      let previous = try store.get(selection)
      let next = Selection(
        search: search ?? previous.search, category: category ?? previous.category)
      guard next != previous else { return }
      catalogTask?.cancel()
      try store.set(select, next)
    } catch { didFail(error) }
  }

  func refresh() async {
    guard !closed, !Task.isCancelled else { return }
    do {
      try store.set(reload)
      // The original Task keeps the read error for SwiftUI; refresh awaits its completion.
      _ = await (try store.get(catalog)).result
    } catch { didFail(error) }
  }

  func close() {
    closed = true
    catalogTask?.cancel()
    catalogTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    catalogTask?.cancel()
  }
}
