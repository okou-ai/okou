import CCState
import ChatData
import ChatDomain
import Foundation

/// One workspace owns the search graph; each presentation owns its requests and debounce.
/// The input lives in the workspace session's Store. The sidebar reads `presented` and the
/// search page reads `field` through CCStateSwiftUI; the synchronous accessors serve actions,
/// the navigation guard and tests.
@MainActor
final class ChatSearchStore {
  private struct Input: Equatable {
    var isPresented = false
    var query = ""
    var requestID = UUID()
    var workflowsRevision = 0
    var closed = false

    var keyword: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
  }

  private struct QueryRequest: Equatable {
    let id: UUID
    let keyword: String
  }

  private enum Action {
    case present
    case query(String)
    case retry, retryWorkflows, dismiss, close
  }

  /// What the search page renders from the input: the field's text, its normalized keyword,
  /// and the error from opening a result.
  struct Field: Equatable {
    var query = ""
    var keyword = ""
    var openingError: String?
  }

  /// The workspace session's Store.
  let stateStore: CCState.Store
  private let input = CCState.State(Input())
  private let openingErrorState = CCState.State<String?>(nil)
  /// Whether the search sheet is presented.
  let presented: Computed<Bool>
  let field: Computed<Field>
  private let transition: Command<Void, Action>
  private var debounceTask: Task<String?, Error>?
  private var messagesTask: Task<[ChatSearchResult], Error>?
  private var artifactsTask: Task<[ChatSearchArtifact], Error>?
  private var workflowsTask: Task<[ChatSearchWorkflow], Error>?
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void

  init(sync: ChatSync, graph: CCState.Store, didFail: @escaping @MainActor (Error) -> Void) {
    self.sync = sync
    self.didFail = didFail
    stateStore = graph
    let input = input
    let openingErrorState = openingErrorState
    presented = Computed { get in try get(input).isPresented }
    field = Computed { get in
      let value = try get(input)
      let openingError = try get(openingErrorState)
      return Field(query: value.query, keyword: value.keyword, openingError: openingError)
    }
    transition = Command { context, action in
      var next = try context.get(input)
      guard !next.closed else { return }
      switch action {
      case .present:
        next.isPresented = true
        next.workflowsRevision += 1
      case .query(let value):
        next.query = value
        next.requestID = UUID()
      case .retry:
        next.requestID = UUID()
      case .retryWorkflows:
        next.workflowsRevision += 1
      case .dismiss, .close:
        next.isPresented = false
        next.query = ""
        next.requestID = UUID()
        if case .close = action { next.closed = true }
      }
      try context.set(input, next)
    }
  }

  private var snapshot: Input {
    // This atom contains only local input; HTTP failures remain in the resource Tasks.
    do { return try stateStore.get(input) } catch {
      preconditionFailure("Cannot read the search input graph: \(error)")
    }
  }

  var isPresented: Bool { snapshot.isPresented }
  var query: String { snapshot.query }
  var keyword: String { snapshot.keyword }
  var requestID: UUID { snapshot.requestID }
  var openingError: String? {
    do { return try stateStore.get(openingErrorState) } catch {
      preconditionFailure("Cannot read the search opening error: \(error)")
    }
  }
  /// The synchronous value of `field`, for a render whose graph read has not resolved.
  var currentField: Field {
    let value = snapshot
    return Field(query: value.query, keyword: value.keyword, openingError: openingError)
  }

  private lazy var queryRequest = Computed<QueryRequest?> { [input] get in
    let value = try get(input)
    guard value.isPresented, !value.closed, !value.keyword.isEmpty else { return nil }
    return QueryRequest(id: value.requestID, keyword: value.keyword)
  }

  private lazy var workflowRequest = Computed<Int?> { [input] get in
    let value = try get(input)
    return value.isPresented && !value.closed ? value.workflowsRevision : nil
  }

  private lazy var keywordValue = Computed { [input] get in
    try get(input).keyword
  }

  private lazy var debouncedKeyword = makeDebouncedKeyword()

  // Keep Task-producing closures out of lazy initializers so Swift can resolve actor defaults.
  private func makeDebouncedKeyword() -> Computed<Task<String?, Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let request = try get(queryRequest)
      let signal = options.signal
      let task = Task<String?, Error> { @MainActor in
        guard let request else { return nil }
        try await Task.sleep(for: .milliseconds(300))
        try Task.checkCancellation()
        try signal.checkCancellation()
        return request.keyword
      }
      debounceTask = task
      signal.onCancel { task.cancel() }
      return task
    }

  }

  lazy var messagesValue = makeMessagesValue()

  private func makeMessagesValue() -> Computed<Task<[ChatSearchResult], Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let keyword = try get(debouncedKeyword)
      let task: Task<[ChatSearchResult], Error> = resourceTask(options.signal) { [sync] in
        guard let keyword = try await keyword.value else { return [] }
        try Task.checkCancellation()
        return try await sync.searchMessages(keyword: keyword)
      }
      messagesTask = task
      return task
    }

  }

  lazy var artifactsValue = makeArtifactsValue()

  private func makeArtifactsValue() -> Computed<Task<[ChatSearchArtifact], Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let keyword = try get(debouncedKeyword)
      let task: Task<[ChatSearchArtifact], Error> = resourceTask(options.signal) { [sync] in
        guard let keyword = try await keyword.value else { return [] }
        try Task.checkCancellation()
        return try await sync.searchArtifacts(keyword: keyword)
      }
      artifactsTask = task
      return task
    }

  }

  private lazy var allWorkflowsValue = makeAllWorkflowsValue()

  private func makeAllWorkflowsValue() -> Computed<Task<[ChatSearchWorkflow], Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let shouldRead = try get(workflowRequest) != nil
      let task: Task<[ChatSearchWorkflow], Error> = resourceTask(options.signal) { [sync] in
        guard shouldRead else { return [] }
        return try await sync.searchWorkflows()
      }
      workflowsTask = task
      return task
    }

  }

  lazy var workflowsValue: Computed<Task<[ChatSearchWorkflow], Error>> =
    computedTask { [keywordValue, allWorkflowsValue] get, options in
      let keyword = try get(keywordValue)
      let pending = try get(allWorkflowsValue)
      let signal = options.signal
      let values = try await pending.value
      try signal.checkCancellation()
      return values.filter { $0.matches(keyword) }
    }

  func titleResults(in threads: [ChatThread]) -> [ChatThread] {
    Self.titleResults(in: threads, keyword: keyword)
  }

  /// Title matches for a keyword; the search page passes the keyword it resolved.
  static func titleResults(in threads: [ChatThread], keyword query: String) -> [ChatThread] {
    let matching = threads.filter { query.isEmpty || $0.displayTitle.lowercased().contains(query) }
    if query.isEmpty { return Array(matching.prefix(25)) }
    return Array(
      matching.sorted { $0.sortAt == $1.sortAt ? $0.id > $1.id : $0.sortAt > $1.sortAt }.prefix(25))
  }

  func present() {
    workflowsTask?.cancel()
    perform(.present)
  }

  func updateQuery(_ value: String) {
    guard !snapshot.closed, value != query else { return }
    cancelQuery()
    setOpeningError(nil)
    perform(.query(value))
  }

  func retry() {
    cancelQuery()
    setOpeningError(nil)
    perform(.retry)
  }

  func retryWorkflows() {
    workflowsTask?.cancel()
    perform(.retryWorkflows)
  }

  func ownsPresentation(_ id: UUID) -> Bool {
    let value = snapshot
    return value.isPresented && !value.closed && value.requestID == id
  }

  func setOpeningError(_ value: String?) {
    do { try stateStore.set(openingErrorState, value) } catch {
      preconditionFailure("Cannot update the search opening error: \(error)")
    }
  }

  func dismiss() {
    cancelQuery()
    workflowsTask?.cancel()
    workflowsTask = nil
    setOpeningError(nil)
    perform(.dismiss)
  }

  func close() {
    cancelQuery()
    workflowsTask?.cancel()
    workflowsTask = nil
    setOpeningError(nil)
    perform(.close)
  }

  private func cancelQuery() {
    messagesTask?.cancel()
    artifactsTask?.cancel()
    debounceTask?.cancel()
    messagesTask = nil
    artifactsTask = nil
    debounceTask = nil
  }

  private func perform(_ action: Action) {
    do { try stateStore.set(transition, action) } catch {
      preconditionFailure("Cannot update the local search input graph: \(error)")
    }
  }

  private func resourceTask<Value: Sendable>(
    _ signal: EvaluationSignal, body: @escaping @MainActor () async throws -> Value
  ) -> Task<Value, Error> {
    // Start outside graph evaluation: reporting a force-upgrade may close this owner.
    let task = Task<Value, Error> { @MainActor [weak self] in
      do {
        try Task.checkCancellation()
        let value = try await body()
        try Task.checkCancellation()
        try signal.checkCancellation()
        return value
      } catch {
        if !Task.isCancelled, !signal.isCancelled { self?.report(error) }
        throw error
      }
    }
    signal.onCancel { task.cancel() }
    return task
  }

  private func report(_ error: Error) {
    guard !snapshot.closed else { return }
    didFail(error)
  }

  isolated deinit {
    messagesTask?.cancel()
    artifactsTask?.cancel()
    debounceTask?.cancel()
    workflowsTask?.cancel()
  }
}
