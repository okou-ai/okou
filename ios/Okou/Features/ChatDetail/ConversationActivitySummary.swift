import CCState
import ChatData
import Foundation
import Observation

struct ConversationActivitySummaryValue: Equatable, Sendable {
  fileprivate let demandID: UUID
  let summary: ChatActivitySummary
}

/// A visible Run owns the original read Task; phrase selection is native presentation state.
@MainActor @Observable
final class ConversationActivitySummary {
  private let lifecycleTasks: LifecycleTasks
  private struct Demand: Equatable, Sendable {
    let runID: String
    let id = UUID()
  }

  let stateStore = CCState.Store()
  @ObservationIgnored private let activeRun = CCState.State<Demand?>(nil)
  @ObservationIgnored private let revision = CCState.State(0)
  @ObservationIgnored private let lifetime = CCState.State(true)
  @ObservationIgnored private let selectRun: Command<Void, Demand?>
  @ObservationIgnored private let reload: Command<Void, Void>
  @ObservationIgnored private let retire: Command<Void, Void>
  private var currentID: String?

  private let sync: ChatSync
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private let threadID: String
  private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private var subscription: Subscription?
  @ObservationIgnored private var current: Task<ConversationActivitySummaryValue?, Error>?
  @ObservationIgnored private var publication: Task<Void, Never>?
  private var generation = UUID()
  private var readID = UUID()
  private var polling: Task<Void, Never>?
  private var rotation: Task<Void, Never>?
  // The original successful Task supplies the native carousel during a pending refresh.
  @ObservationIgnored private var rotationRead: Task<ConversationActivitySummaryValue?, Error>?
  private var phraseCount = 0
  private var rotates = true
  private var closed = false

  init(
    sync: ChatSync, threadID: String, didRequireUpgrade: @escaping @MainActor (Error) -> Void,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    self.didRequireUpgrade = didRequireUpgrade
    self.sync = sync
    self.threadID = threadID
    self.sleep = sleep
    let activeRun = activeRun
    let revision = revision
    let lifetime = lifetime
    selectRun = Command { context, runID in try context.set(activeRun, runID) }
    reload = Command { context in
      guard try context.get(lifetime), try context.get(activeRun) != nil else { return }
      try context.set(revision, update: { $0 + 1 })
    }
    retire = Command { context in try context.set(lifetime, false) }
  }

  @ObservationIgnored lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ConversationActivitySummaryValue?, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime) else { throw CancellationError() }
      let demand = try get(activeRun)
      _ = try get(revision)
      let signal = options.signal
      let task = Task.immediate { @MainActor [sync, threadID] in
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard let demand else { return nil as ConversationActivitySummaryValue? }
        let summary = try await sync.activitySummary(threadID: threadID, runID: demand.runID)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return ConversationActivitySummaryValue(demandID: demand.id, summary: summary)
      }
      lifecycleTasks.track(task)
      current = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func text(in value: ConversationActivitySummaryValue?) -> String? {
    // keepLast is only a same-demand presentation; an old Run cannot supply its phrase.
    _ = generation
    guard !closed, let value, value.summary.status == .available else { return nil }
    do {
      guard try stateStore.get(activeRun)?.id == value.demandID else { return nil }
    } catch { preconditionFailure("Cannot read the local activity demand: \(error)") }
    let summary = value.summary
    return (summary.messages.first { $0.id == currentID } ?? summary.messages.first)?.text
  }

  func demand(_ next: String?) {
    guard !closed else { return }
    do {
      guard try stateStore.get(activeRun)?.runID != next else { return }
      stopWork()
      try stateStore.set(selectRun, next.map { Demand(runID: $0) })
      guard next != nil else { return }
      subscription = try stateStore.watch(value) { [weak self] in self?.reconcileRead() }
      reconcileRead()
      let owner = generation
      polling = Task { [weak self, sleep] in
        do {
          while !Task.isCancelled {
            // Reading refreshes immediately on demand, independently of phrase rotation.
            try await sleep(.seconds(15))
            try Task.checkCancellation()
            guard let self, !self.closed, self.generation == owner else { return }
            self.retry()
          }
        } catch {
          // Ending the demand cancels its refresh clock.
        }
      }
      if let polling { lifecycleTasks.track(polling) }
    } catch { preconditionFailure("Cannot update the local activity demand: \(error)") }
  }

  func retry() {
    guard !closed else { return }
    do { try stateStore.set(reload) } catch {
      preconditionFailure("Cannot refresh the local activity resource: \(error)")
    }
  }

  func setRotates(_ enabled: Bool) {
    guard rotates != enabled else { return }
    rotates = enabled
    reconcileRotation()
  }

  func close() {
    stopWork()
    guard !closed else { return }
    closed = true
    do { try stateStore.set(retire) } catch {
      preconditionFailure("Cannot retire the local activity resource: \(error)")
    }
  }

  private func stopWork() {
    generation = UUID()
    readID = UUID()
    polling?.cancel()
    current?.cancel()
    publication?.cancel()
    rotation?.cancel()
    polling = nil
    current = nil
    publication = nil
    rotation = nil
    rotationRead = nil
    do { try subscription?.cancel() } catch {
      preconditionFailure("Cannot detach the local activity subscription: \(error)")
    }
    subscription = nil
    phraseCount = 0
    currentID = nil
  }

  /// This waiter owns only native phrase selection/cadence, never a second read snapshot.
  private func reconcileRead() {
    publication?.cancel()
    let id = UUID()
    readID = id
    do {
      let read = try stateStore.get(value)
      publication = Task { [weak self] in
        do {
          let value = try await read.value
          try Task.checkCancellation()
          guard let self, !closed, readID == id else { return }
          let messages: [ChatActivitySummary.Message]
          if let value, value.summary.status == .available {
            messages = value.summary.messages
          } else {
            messages = []
          }
          rotationRead = read
          let previousCount = phraseCount
          phraseCount = messages.count
          if !messages.contains(where: { $0.id == currentID }) { currentID = messages.first?.id }
          // A same-size refresh preserves both phrase selection and the running clock.
          if previousCount != phraseCount { reconcileRotation() }
        } catch is CancellationError {
        } catch {
          guard !Task.isCancelled, let self, !closed, readID == id else { return }
          rotationRead = nil
          phraseCount = 0
          currentID = nil
          reconcileRotation()
          if (error as? APIClientError)?.statusCode == 426 { didRequireUpgrade(error) }
        }
      }
      if let publication { lifecycleTasks.track(publication) }
    } catch is CancellationError {
    } catch { preconditionFailure("Cannot observe the local activity resource: \(error)") }
  }

  private func reconcileRotation() {
    rotation?.cancel()
    rotation = nil
    guard rotates, phraseCount > 1, !closed else { return }
    let owner = generation
    rotation = Task { [weak self, sleep] in
      do {
        while !Task.isCancelled {
          try await sleep(.seconds(5))
          try Task.checkCancellation()
          guard let self, !self.closed, self.generation == owner else { return }
          guard let read = self.rotationRead else { return }
          let value = try await read.value
          try Task.checkCancellation()
          guard self.generation == owner, let value, value.summary.status == .available,
            value.summary.messages.count > 1
          else { return }
          let messages = value.summary.messages
          let index = messages.firstIndex { $0.id == self.currentID } ?? 0
          self.currentID = messages[(index + 1) % messages.count].id
        }
      } catch is CancellationError {
      } catch {
        // The original read keeps its failure; reconcileRead owns native failure cleanup.
      }
    }
    if let rotation { lifecycleTasks.track(rotation) }
  }

  isolated deinit {
    polling?.cancel()
    current?.cancel()
    publication?.cancel()
    rotation?.cancel()
    do {
      try subscription?.cancel()
      try stateStore.set(retire)
    } catch { preconditionFailure("Cannot retire the activity summary: \(error)") }
  }
}
