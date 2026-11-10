import CCState
import ChatData
import Foundation
import Observation

/// One visible detail owns the original read; summary failures never change authoritative chat state.
@MainActor
final class ConversationActivitySummary {
  struct Demand: Equatable, Sendable {
    let runID: String
    let id = UUID()
  }

  struct Read: Equatable, Sendable {
    let demand: Demand
    let summary: ChatActivitySummary

    func messages(for current: Demand?) -> [ChatActivitySummary.Message] {
      demand == current && summary.status == .available ? summary.messages : []
    }
  }

  let stateStore = CCState.Store()
  let phrases: ConversationActivityPhrases
  private let demandInput = CCState.State<Demand?>(nil)
  private let revision = CCState.State(0)
  private let closed = CCState.State(false)
  private let changeDemand: Command<Void, String?>
  private let reload: Command<Void, Void>
  private let retire: Command<Void, Void>
  private let sync: ChatSync
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private let threadID: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private var polling: Task<Void, Never>?
  private var request: Task<Read?, Error>?

  init(
    sync: ChatSync, threadID: String, didRequireUpgrade: @escaping @MainActor (Error) -> Void,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.didRequireUpgrade = didRequireUpgrade
    self.sync = sync
    self.threadID = threadID
    self.sleep = sleep
    phrases = ConversationActivityPhrases(sleep: sleep)
    let demandInput = demandInput
    let revision = revision
    let closed = closed
    changeDemand = Command { context, next in
      guard try !context.get(closed) else { throw CancellationError() }
      guard try context.get(demandInput)?.runID != next else { return }
      try context.set(demandInput, next.map { Demand(runID: $0) })
    }
    reload = Command { context in
      guard try !context.get(closed), try context.get(demandInput) != nil else {
        throw CancellationError()
      }
      try context.set(revision, update: { $0 + 1 })
    }
    retire = Command { context in
      try context.set(closed, true)
      try context.set(demandInput, nil)
    }
  }

  lazy var activeDemand = Computed { [demandInput] get in try get(demandInput) }
  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<Read?, Error>> {
    Computed { [weak self] get, options in
      guard let self else { throw CancellationError() }
      let isClosed = try get(closed)
      let demand = try get(demandInput)
      _ = try get(revision)
      let signal = options.signal
      let task = Task<Read?, Error> { @MainActor [weak self, sync, threadID] in
        guard !isClosed, let demand else { return nil }
        do {
          try Task.checkCancellation()
          let result = try await sync.activitySummary(threadID: threadID, runID: demand.runID)
          try Task.checkCancellation()
          try signal.checkCancellation()
          // Only native selection/cadence is retained, never a second summary or error cache.
          self?.phrases.use(result.status == .available ? result.messages.map(\.id) : [])
          return Read(demand: demand, summary: result)
        } catch {
          if !Task.isCancelled, !signal.isCancelled {
            self?.phrases.use([])
            if (error as? APIClientError)?.statusCode == 426 { self?.didRequireUpgrade(error) }
          }
          throw error
        }
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func demand(_ next: String?) {
    do {
      guard try !stateStore.get(closed), try stateStore.get(demandInput)?.runID != next else {
        return
      }
      polling?.cancel()
      polling = nil
      request?.cancel()
      phrases.use([])
      try stateStore.set(changeDemand, next)
      // Starting and cancelling the read belongs to demand, not a mounted footer's waiter.
      _ = try stateStore.get(value)
      guard next != nil else { return }
      polling = Task { [weak self, sleep] in
        do {
          while !Task.isCancelled {
            // PWA requests immediately, then on a fixed 15-second cadence.
            try await sleep(.seconds(15))
            try Task.checkCancellation()
            guard let self else { return }
            try stateStore.set(reload)
            _ = try stateStore.get(value)
          }
        } catch is CancellationError {
        } catch { self?.didRequireUpgrade(error) }
      }
    } catch is CancellationError {
    } catch { didRequireUpgrade(error) }
  }

  func close() {
    polling?.cancel()
    polling = nil
    request?.cancel()
    request = nil
    phrases.use([])
    do {
      try stateStore.set(retire)
      _ = try stateStore.get(value)
    } catch { didRequireUpgrade(error) }
  }

  isolated deinit {
    polling?.cancel()
    request?.cancel()
  }
}

/// Native phrase selection and VoiceOver control have a separate lifetime from the read timer.
@MainActor @Observable
final class ConversationActivityPhrases {
  private var currentID: String?
  private var ids: [String] = []
  private var rotates = true
  private let sleep: @Sendable (Duration) async throws -> Void
  private var rotation: Task<Void, Never>?

  init(sleep: @escaping @Sendable (Duration) async throws -> Void) { self.sleep = sleep }

  func text(in messages: [ChatActivitySummary.Message]) -> String? {
    (messages.first { $0.id == currentID } ?? messages.first)?.text
  }

  func use(_ next: [String]) {
    let previousCount = ids.count
    if ids != next { ids = next }
    if !next.contains(where: { $0 == currentID }) { currentID = next.first }
    // Retain the current phrase and cadence when a same-size batch refreshes.
    if previousCount != next.count { reconcileRotation() }
  }

  func setRotates(_ enabled: Bool) {
    guard rotates != enabled else { return }
    rotates = enabled
    reconcileRotation()
  }

  private func reconcileRotation() {
    rotation?.cancel()
    rotation = nil
    guard rotates, ids.count > 1 else { return }
    rotation = Task { [weak self, sleep] in
      do {
        while !Task.isCancelled {
          try await sleep(.seconds(5))
          try Task.checkCancellation()
          guard let self, self.ids.count > 1 else { return }
          let index = self.ids.firstIndex { $0 == self.currentID } ?? 0
          self.currentID = self.ids[(index + 1) % self.ids.count]
        }
      } catch {}
    }
  }

  isolated deinit { rotation?.cancel() }
}
