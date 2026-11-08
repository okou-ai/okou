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
    let agentID: String
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  }

  private struct Filter: Equatable {
    var query: String?
    var recent: [String] = []
  }

  private enum Action {
    case filter(Filter), reload(Request), dismiss
  }

  let store = CCState.Store()
  private let request = CCState.State<Request?>(nil)
  private let filter = CCState.State(Filter())
  private let transition: Command<Void, Action>
  private var task: Task<[ComposerWorkflow], Error>?

  init() {
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

  private func makeCandidates() -> Computed<Task<[ComposerWorkflow], Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let request = try get(request)
      let signal = options.signal
      // A 426 may close the workspace; report it after graph evaluation has ended.
      let task = Task<[ComposerWorkflow], Error> { @MainActor in
        guard let request else { return [] }
        try Task.checkCancellation()
        let result = try await request.source.load(agentID: request.agentID)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return result
      }
      self.task = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  lazy var matches: Computed<Task<Matches, Error>> = computedTask {
    [request, filter, candidates] get, options in
    let request = try get(request)
    let filter = try get(filter)
    let pending = try get(candidates)
    let signal = options.signal
    let workflows = try await pending.value
    try Task.checkCancellation()
    try signal.checkCancellation()
    let values = filter.query.map {
      ComposerWorkflowSearch.matches(workflows, query: $0, recent: filter.recent)
    } ?? []
    return Matches(requestID: request?.id, query: filter.query, values: values)
  }

  func update(query: String, recent: [String]) {
    perform(.filter(Filter(query: query, recent: recent)))
  }

  func reload(source: ComposerWorkflowSource, agentID: String) {
    task?.cancel()
    task = nil
    perform(.reload(Request(source: source, agentID: agentID)))
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
