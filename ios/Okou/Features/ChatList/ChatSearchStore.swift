import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// One workspace owns the search graph; each presentation owns its requests and debounce.
@MainActor @Observable
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

  @ObservationIgnored let stateStore = CCState.Store()
  @ObservationIgnored private let input = CCState.State(Input())
  @ObservationIgnored private let presentedValue: Computed<Bool>
  @ObservationIgnored private let rawQueryValue: Computed<String>
  @ObservationIgnored private let transition: Command<Void, Action>
  @ObservationIgnored private var subscriptions: [Subscription] = []
  @ObservationIgnored private var debounceTask: Task<String?, Error>?
  @ObservationIgnored private var messagesTask: Task<[ChatSearchResult], Error>?
  @ObservationIgnored private var artifactsTask: Task<[ChatSearchArtifact], Error>?
  @ObservationIgnored private var workflowsTask: Task<[ChatSearchWorkflow], Error>?
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private(set) var openingError: String?

  init(sync: ChatSync, didFail: @escaping @MainActor (Error) -> Void) {
    self.sync = sync
    self.didFail = didFail
    let input = input
    presentedValue = Computed { get in try get(input).isPresented }
    rawQueryValue = Computed { get in try get(input).query }
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
    do {
      let presented = try stateStore.watch(presentedValue) { [weak self] in
        guard let self else { return }
        // The sidebar and navigation guard need synchronous identity, not a second state copy.
        withMutation(keyPath: \.isPresented) {}
      }
      subscriptions.append(presented)
      let query = try stateStore.watch(rawQueryValue) { [weak self] in
        guard let self else { return }
        withMutation(keyPath: \.query) {}
      }
      subscriptions.append(query)
    } catch { preconditionFailure("Cannot observe the search input graph: \(error)") }
  }

  private var snapshot: Input {
    // This atom contains only local input; HTTP failures remain in the resource Tasks.
    do { return try stateStore.get(input) } catch {
      preconditionFailure("Cannot read the search input graph: \(error)")
    }
  }

  var isPresented: Bool {
    access(keyPath: \.isPresented)
    return snapshot.isPresented
  }
  var query: String {
    access(keyPath: \.query)
    return snapshot.query
  }
  var keyword: String {
    access(keyPath: \.query)
    return snapshot.keyword
  }
  var requestID: UUID { snapshot.requestID }

  @ObservationIgnored private lazy var queryRequest = Computed<QueryRequest?> { [input] get in
    let value = try get(input)
    guard value.isPresented, !value.closed, !value.keyword.isEmpty else { return nil }
    return QueryRequest(id: value.requestID, keyword: value.keyword)
  }

  @ObservationIgnored private lazy var workflowRequest = Computed<Int?> { [input] get in
    let value = try get(input)
    return value.isPresented && !value.closed ? value.workflowsRevision : nil
  }

  @ObservationIgnored private lazy var keywordValue = Computed { [input] get in
    try get(input).keyword
  }

  @ObservationIgnored private lazy var debouncedKeyword = Computed<Task<String?, Error>> {
    [weak self] get, options in
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

  @ObservationIgnored lazy var messagesValue = Computed<Task<[ChatSearchResult], Error>> {
    [weak self] get, options in
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

  @ObservationIgnored lazy var artifactsValue = Computed<Task<[ChatSearchArtifact], Error>> {
    [weak self] get, options in
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

  @ObservationIgnored private lazy var allWorkflowsValue = Computed<
    Task<[ChatSearchWorkflow], Error>
  > { [weak self] get, options in
    guard let self else { throw CancellationError() }
    let shouldRead = try get(workflowRequest) != nil
    let task: Task<[ChatSearchWorkflow], Error> = resourceTask(options.signal) { [sync] in
      guard shouldRead else { return [] }
      return try await sync.searchWorkflows()
    }
    workflowsTask = task
    return task
  }

  @ObservationIgnored lazy var workflowsValue: Computed<Task<[ChatSearchWorkflow], Error>> =
    computedTask { [keywordValue, allWorkflowsValue] get, options in
      let keyword = try get(keywordValue)
      let pending = try get(allWorkflowsValue)
      let signal = options.signal
      let values = try await pending.value
      try signal.checkCancellation()
      return values.filter { $0.matches(keyword) }
    }

  func titleResults(in threads: [ChatThread]) -> [ChatThread] {
    let query = keyword
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
    openingError = nil
    perform(.query(value))
  }

  func retry() {
    cancelQuery()
    openingError = nil
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

  func setOpeningError(_ value: String?) { openingError = value }

  func dismiss() {
    cancelQuery()
    workflowsTask?.cancel()
    workflowsTask = nil
    openingError = nil
    perform(.dismiss)
  }

  func close() {
    cancelQuery()
    workflowsTask?.cancel()
    workflowsTask = nil
    openingError = nil
    perform(.close)
    stopObserving()
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

  private func stopObserving() {
    for subscription in subscriptions {
      do { try subscription.cancel() } catch {
        preconditionFailure("Cannot release the search input graph: \(error)")
      }
    }
    subscriptions = []
  }

  isolated deinit {
    messagesTask?.cancel()
    artifactsTask?.cancel()
    debounceTask?.cancel()
    workflowsTask?.cancel()
    stopObserving()
  }
}
