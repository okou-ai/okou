import CCState
import ChatData
import Foundation

struct ConversationActivitySummaryValue: Equatable, Sendable {
  fileprivate let demandID: UUID
  let summary: ChatActivitySummary
}

/// A visible Run owns the original read Task. The read's demand and the rotating phrase live in
/// the workspace session's Store. The commands that change the demand reconcile the phrase
/// rotation themselves, so nothing subscribes to the graph.
@MainActor
final class ConversationActivitySummary {
  /// Which Run's read may supply a phrase, and the phrase the rotation selected.
  struct Selection: Equatable {
    let demandID: UUID?
    let phraseID: String?
  }

  private let lifecycleTasks: LifecycleTasks
  private struct Demand: Equatable, Sendable {
    let runID: String
    let id = UUID()
  }

  /// The workspace session's Store, which keeps this summary's demand.
  let store: CCState.Store
  private let activeRun = CCState.State<Demand?>(nil)
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let selectRun: Command<Void, Demand?>
  private let reload: Command<Void, Void>
  private let retire: Command<Void, Void>
  private let phrase = CCState.State<String?>(nil)
  let selection: Computed<Selection>

  private let sync: ChatSync
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private let threadID: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private var current: Task<ConversationActivitySummaryValue?, Error>?
  private var publication: Task<Void, Never>?
  private var generation = UUID()
  private var readID = UUID()
  private var polling: Task<Void, Never>?
  private var rotation: Task<Void, Never>?
  // The original successful Task supplies the native carousel during a pending refresh.
  private var rotationRead: Task<ConversationActivitySummaryValue?, Error>?
  private var phraseCount = 0
  private var rotates = true
  private var closed = false

  init(
    sync: ChatSync, threadID: String, graph: CCState.Store,
    didRequireUpgrade: @escaping @MainActor (Error) -> Void,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    store = graph
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
    let phrase = phrase
    selection = Computed { get in
      guard try get(lifetime) else { return Selection(demandID: nil, phraseID: nil) }
      let demand = try get(activeRun)
      let phraseID = try get(phrase)
      return Selection(demandID: demand?.id, phraseID: phraseID)
    }
  }

  lazy var value = makeValue()

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
    Self.text(in: value, selection: snapshot(of: selection))
  }

  static func text(in value: ConversationActivitySummaryValue?, selection: Selection) -> String? {
    // keepLast is only a same-demand presentation; an old Run cannot supply its phrase.
    guard let value, value.summary.status == .available, selection.demandID == value.demandID
    else { return nil }
    let messages = value.summary.messages
    return (messages.first { $0.id == selection.phraseID } ?? messages.first)?.text
  }

  func demand(_ next: String?) {
    guard !closed else { return }
    do {
      guard try store.get(activeRun)?.runID != next else { return }
      stopWork()
      try store.set(selectRun, next.map { Demand(runID: $0) })
      guard next != nil else { return }
      // Selecting a Run starts its read here; no subscription relays the change.
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
    do {
      guard try store.get(activeRun) != nil else { return }
      try store.set(reload)
    } catch {
      preconditionFailure("Cannot refresh the local activity resource: \(error)")
    }
    // The reload replaced the read; the phrase rotation follows the new one.
    reconcileRead()
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
    do { try store.set(retire) } catch {
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
    phraseCount = 0
    write(phrase, nil)
  }

  /// This waiter owns only native phrase selection/cadence, never a second read snapshot.
  private func reconcileRead() {
    publication?.cancel()
    let id = UUID()
    readID = id
    do {
      let read = try store.get(value)
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
          let selected = snapshot(of: phrase)
          if !messages.contains(where: { $0.id == selected }) { write(phrase, messages.first?.id) }
          // A same-size refresh preserves both phrase selection and the running clock.
          if previousCount != phraseCount { reconcileRotation() }
        } catch is CancellationError {
        } catch {
          guard !Task.isCancelled, let self, !closed, readID == id else { return }
          rotationRead = nil
          phraseCount = 0
          write(phrase, nil)
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
          let selected = self.snapshot(of: self.phrase)
          let index = messages.firstIndex { $0.id == selected } ?? 0
          self.write(self.phrase, messages[(index + 1) % messages.count].id)
        }
      } catch is CancellationError {
      } catch {
        // The original read keeps its failure; reconcileRead owns native failure cleanup.
      }
    }
    if let rotation { lifecycleTasks.track(rotation) }
  }

  // The demand and phrase are synchronous in-process values; reads and writes cannot fail.
  private func snapshot<Value>(of signal: Signal<Value>) -> Value {
    do { return try store.get(signal) } catch {
      preconditionFailure("Cannot read the local activity graph: \(error)")
    }
  }

  private func write<Value>(_ state: CCState.State<Value>, _ value: Value) {
    do { try store.set(state, value) } catch {
      preconditionFailure("Cannot update the local activity graph: \(error)")
    }
  }

  isolated deinit {
    polling?.cancel()
    current?.cancel()
    publication?.cancel()
    rotation?.cancel()
    do { try store.set(retire) } catch {
      preconditionFailure("Cannot retire the activity summary: \(error)")
    }
  }
}
