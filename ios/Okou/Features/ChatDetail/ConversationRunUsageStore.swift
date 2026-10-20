import ChatData
import Foundation
import Observation

enum ConversationRunUsageState: Equatable {
  case loading
  case available(ChatRunUsage)
  case unavailable
  case failed(String)
}

/// One immutable conversation scope; only runs represented in the render window own reads.
@MainActor @Observable
final class ConversationRunUsageStore {
  private(set) var states: [String: ConversationRunUsageState] = [:]
  private let sync: ChatSync
  private let threadID: String
  private let didFail: @MainActor (Error) -> Void
  private var requestedEvents: [String: String] = [:]
  private var wanted: [String: String] = [:]
  private var recentRunIDs: [String] = []
  private var task: Task<Void, Never>?
  private var readingRunIDs = Set<String>()
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
      uniqueKeysWithValues: Set(runIDs).compactMap { id in
        events[id].map { (id, $0) }
      })
    recentRunIDs.removeAll { wanted[$0] != nil }
    recentRunIDs.append(contentsOf: wanted.keys.sorted())
    recentRunIDs = Array(recentRunIDs.suffix(max(128, wanted.count)))
    let retained = Set(recentRunIDs)
    states = states.filter { retained.contains($0.key) }
    requestedEvents = requestedEvents.filter { retained.contains($0.key) }
    startReading()
  }

  func retry(_ runID: String) {
    guard !closed, wanted[runID] != nil, !readingRunIDs.contains(runID) else { return }
    requestedEvents[runID] = nil
    states[runID] = .loading
    startReading()
  }

  func close() {
    closed = true
    generation = UUID()
    task?.cancel()
    task = nil
    states = [:]
    requestedEvents = [:]
    wanted = [:]
    recentRunIDs = []
    readingRunIDs = []
  }

  private func startReading() {
    guard task == nil, !closed else { return }
    let pending = wanted.filter { requestedEvents[$0.key] != $0.value }
    guard !pending.isEmpty else { return }
    let entries = pending.sorted { $0.key < $1.key }.prefix(100)
    let batch = Dictionary(uniqueKeysWithValues: entries.map { ($0.key, $0.value) })
    readingRunIDs = Set(batch.keys)
    let request = generation
    for (id, event) in batch {
      requestedEvents[id] = event
      if states[id] == nil { states[id] = .loading }
    }
    task = Task { [weak self] in
      guard let self else { return }
      defer {
        if generation == request {
          task = nil
          readingRunIDs = []
          startReading()
        }
      }
      do {
        let result = try await sync.runUsage(threadID: threadID, runIDs: Array(batch.keys))
        guard !closed, !Task.isCancelled, generation == request else { return }
        for (id, event) in batch
        where requestedEvents[id] == event && (wanted[id] == nil || wanted[id] == event) {
          states[id] = result[id].map(ConversationRunUsageState.available) ?? .unavailable
        }
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled, generation == request else { return }
        for (id, event) in batch
        where requestedEvents[id] == event && (wanted[id] == nil || wanted[id] == event) {
          states[id] = .failed(error.localizedDescription)
        }
        if let status = (error as? APIClientError)?.statusCode, status == 401 || status == 426 {
          didFail(error)
        }
      }
    }
  }
}
