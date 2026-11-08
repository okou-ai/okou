import CCState
import ChatData
import Foundation
import Observation

/// Stable per-Run reads share the conversation's bounded HTTP batches.
@MainActor
final class ConversationRunUsageResource {
  private let source: CCState.State<ConversationRunUsageRead>
  private let lifetime = CCState.State(true)
  private let replace: Command<Void, ConversationRunUsageRead>
  private var current: Task<ChatRunUsage?, Error>?
  let runID: String

  fileprivate init(runID: String, read: ConversationRunUsageRead) {
    self.runID = runID
    let source = CCState.State(read)
    self.source = source
    replace = Command { context, read in try context.set(source, read) }
  }

  lazy var value: Computed<Task<ChatRunUsage?, Error>> = Computed { [weak self] get, options in
    guard let self, try get(lifetime) else { throw CancellationError() }
    let read = try get(source)
    _ = try get(read.batch)
    current = read.task
    // Invalidating one Run never cancels another Run's shared HTTP batch.
    options.signal.onCancel { read.task.cancel() }
    return read.task
  }

  fileprivate func use(_ read: ConversationRunUsageRead, in store: CCState.Store) throws {
    current?.cancel()
    try store.set(replace, read)
  }

  fileprivate func close(in store: CCState.Store) throws {
    current?.cancel()
    current = nil
    try store.set(lifetime, false)
  }

  isolated deinit { current?.cancel() }
}

@MainActor
private final class ConversationRunUsageRead {
  let task: Task<ChatRunUsage?, Error>
  let batch: Computed<Task<Void, Error>>

  init(task: Task<ChatRunUsage?, Error>, batch: Computed<Task<Void, Error>>) {
    self.task = task
    self.batch = batch
  }

  isolated deinit { task.cancel() }
}

@MainActor
private final class ConversationRunUsageBatch {
  let events: [String: String]
  private(set) var reads: [String: ConversationRunUsageRead] = [:]
  private var replies: [String: AsyncStream<Result<ChatRunUsage?, Error>>.Continuation] = [:]
  private let sync: ChatSync
  private let threadID: String
  private let completed: @MainActor () -> Void
  private let failed: @MainActor (Error) -> Void
  private var request: Task<Void, Error>?

  init(
    events: [String: String], sync: ChatSync, threadID: String,
    completed: @escaping @MainActor () -> Void, failed: @escaping @MainActor (Error) -> Void
  ) {
    self.events = events
    self.sync = sync
    self.threadID = threadID
    self.completed = completed
    self.failed = failed
    for id in events.keys {
      let (stream, reply) = AsyncStream<Result<ChatRunUsage?, Error>>.makeStream(
        bufferingPolicy: .bufferingOldest(1))
      replies[id] = reply
      let task = Task<ChatRunUsage?, Error> { @MainActor in
        for await result in stream {
          try Task.checkCancellation()
          return try result.get()
        }
        throw CancellationError()
      }
      reads[id] = ConversationRunUsageRead(task: task, batch: value)
    }
  }

  lazy var value: Computed<Task<Void, Error>> = Computed { [weak self] _, options in
    guard let self else { throw CancellationError() }
    let signal = options.signal
    let task = Task<Void, Error> {
      @MainActor [self, sync, threadID, events, replies, completed, failed] in
      let outcome: Result<[String: ChatRunUsage], Error>
      do {
        try Task.checkCancellation()
        let result = try await sync.runUsage(threadID: threadID, runIDs: Array(events.keys))
        try Task.checkCancellation()
        try signal.checkCancellation()
        outcome = .success(result)
      } catch {
        outcome = .failure(error)
        if !Task.isCancelled, !signal.isCancelled { failed(error) }
      }
      // Replace superseded Run signals before delivering any old result.
      completed()
      for (id, reply) in replies {
        reply.yield(outcome.map { $0[id] })
        reply.finish()
      }
      self.request = nil
      // Keep per-Run results in their Tasks, not a second retained batch-result cache.
      return try outcome.map { _ in () }.get()
    }
    request = task
    signal.onCancel { task.cancel() }
    return task
  }

  func cancel() { request?.cancel() }
  isolated deinit {
    request?.cancel()
    for reply in replies.values { reply.finish() }
  }
}

/// One immutable conversation scope; only Runs represented in the render window own reads.
@MainActor @Observable
final class ConversationRunUsageStore {
  let stateStore = CCState.Store()
  private(set) var resources: [String: ConversationRunUsageResource] = [:]
  private let sync: ChatSync
  private let threadID: String
  private let didFail: @MainActor (Error) -> Void
  private var requestedEvents: [String: String] = [:]
  private var wanted: [String: String] = [:]
  private var recentRunIDs: [String] = []
  private var active: ConversationRunUsageBatch?
  private var generation = UUID()
  private var closed = false

  init(sync: ChatSync, threadID: String, didFail: @escaping @MainActor (Error) -> Void) {
    self.sync = sync
    self.threadID = threadID
    self.didFail = didFail
  }

  func update(runIDs: [String], events: [String: String]) {
    guard !closed else { return }
    wanted = Dictionary(
      uniqueKeysWithValues: Set(runIDs).compactMap { id in events[id].map { (id, $0) } })
    recentRunIDs.removeAll { wanted[$0] != nil }
    recentRunIDs.append(contentsOf: wanted.keys.sorted())
    recentRunIDs = Array(recentRunIDs.suffix(max(128, wanted.count)))
    let retained = Set(recentRunIDs)
    for (id, resource) in resources where !retained.contains(id) {
      do { try resource.close(in: stateStore) } catch { didFail(error) }
    }
    resources = resources.filter { retained.contains($0.key) }
    requestedEvents = requestedEvents.filter { retained.contains($0.key) }
    if wanted.isEmpty { stopReading() }
    startReading()
  }

  func retry(_ runID: String) {
    guard !closed, wanted[runID] != nil, active?.events[runID] == nil else { return }
    requestedEvents[runID] = nil
    startReading()
  }

  func close() {
    closed = true
    stopReading()
    for resource in resources.values {
      do { try resource.close(in: stateStore) } catch { didFail(error) }
    }
    resources = [:]
    requestedEvents = [:]
    wanted = [:]
    recentRunIDs = []
  }

  private func stopReading() {
    generation = UUID()
    active?.cancel()
    if let active {
      for id in active.events.keys { requestedEvents[id] = nil }
    }
    active = nil
  }

  private func startReading() {
    guard active == nil, !closed else { return }
    let pending = wanted.filter { requestedEvents[$0.key] != $0.value }
    guard !pending.isEmpty else { return }
    let entries = pending.sorted { $0.key < $1.key }.prefix(100)
    let events = Dictionary(uniqueKeysWithValues: entries.map { ($0.key, $0.value) })
    let request = generation
    let batch = ConversationRunUsageBatch(
      events: events, sync: sync, threadID: threadID,
      completed: { [weak self] in
        guard let self, !closed, generation == request else { return }
        for id in events.keys where wanted[id] == nil { requestedEvents[id] = nil }
        active = nil
        startReading()
      },
      failed: { [weak self] error in
        guard let self, !closed, generation == request else { return }
        if let status = (error as? APIClientError)?.statusCode, status == 401 || status == 426 {
          didFail(error)
        }
      })
    active = batch
    do {
      for (id, read) in batch.reads {
        requestedEvents[id] = events[id]
        if let existing = resources[id] {
          try existing.use(read, in: stateStore)
        } else {
          resources[id] = ConversationRunUsageResource(runID: id, read: read)
        }
      }
      // The conversation starts one shared batch, independently of mounted subscribers.
      _ = try stateStore.get(batch.value)
    } catch { didFail(error) }
  }
}
