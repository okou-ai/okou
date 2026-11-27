import CCState
import ChatData
import Foundation

/// The native slash interaction owns this graph and the original candidate request.
@MainActor
final class ComposerWorkflowResources {
  struct Matches: Equatable, Sendable {
    let requestID: UUID?
    let query: String?
    let values: [ComposerWorkflow]
  }

  private struct Request: Equatable {
    let id = UUID()
    let source: ComposerWorkflowSource
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  }

  private struct Filter: Equatable {
    var query: String?
  }

  private enum Action {
    case filter(Filter)
    case reload(Request)
    case dismiss
  }

  /// The workspace session's Store, which keeps the candidate request's graph values.
  let store: CCState.Store
  private let request = CCState.State<Request?>(nil)
  private let filter = CCState.State(Filter())
  private let transition: Command<Void, Action>
  private var task: Task<ComposerWorkflowSource.Catalog, Error>?

  init(graph: CCState.Store) {
    store = graph
    let request = request
    let filter = filter
    transition = Command { context, action in
      switch action {
      case .filter(let value): try context.set(filter, value)
      case .reload(let value): try context.set(request, value)
      case .dismiss:
        try context.set(request, nil)
        try context.set(filter, Filter())
      }
    }
  }

  private lazy var candidates = makeCandidates()

  private func makeCandidates() -> Computed<Task<ComposerWorkflowSource.Catalog, Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let request = try get(request)
      let signal = options.signal
      // A 426 may close the workspace; report it after graph evaluation has ended.
      let task = Task<ComposerWorkflowSource.Catalog, Error> { @MainActor in
        guard let request else { return .init(workflows: [], recent: []) }
        try Task.checkCancellation()
        let result = try await request.source.loadCatalog()
        try Task.checkCancellation()
        try signal.checkCancellation()
        return result
      }
      self.task = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  lazy var matches: Computed<Task<Matches, Error>> =
    computedTask { [request, filter, candidates] get, options in
      let request = try get(request)
      let filter = try get(filter)
      let pending = try get(candidates)
      let signal = options.signal
      let catalog = try await pending.value
      try Task.checkCancellation()
      try signal.checkCancellation()
      let values =
        filter.query.map {
          ComposerWorkflowSearch.matches(catalog.workflows, query: $0, recent: catalog.recent)
        } ?? []
      return Matches(requestID: request?.id, query: filter.query, values: values)
    }

  func update(query: String) {
    perform(.filter(Filter(query: query)))
  }

  func reload(source: ComposerWorkflowSource) {
    task?.cancel()
    task = nil
    perform(.reload(Request(source: source)))
  }

  func dismiss() {
    task?.cancel()
    task = nil
    perform(.dismiss)
  }

  /// A native table may still be displaying rows from a previous query or request.
  func owns(_ result: Matches) -> Bool {
    do {
      return try store.get(request)?.id == result.requestID
        && store.get(filter).query == result.query
    } catch { preconditionFailure("Cannot read local Workflow inputs: \(error)") }
  }

  private func perform(_ action: Action) {
    do { try store.set(transition, action) } catch {
      preconditionFailure("Cannot update local Workflow inputs: \(error)")
    }
  }

  isolated deinit { task?.cancel() }
}
