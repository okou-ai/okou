import ChatData
import Foundation
import Observation

/// One visible detail owns one demand. Summary failures never change authoritative chat state.
@MainActor @Observable
final class ConversationActivitySummary {
  private(set) var messages: [ChatActivitySummary.Message] = []
  private var currentID: String?
  var text: String? { (messages.first { $0.id == currentID } ?? messages.first)?.text }

  private let sync: ChatSync
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private let threadID: String
  private let sleep: @Sendable (Duration) async throws -> Void
  private var runID: String?
  private var generation = UUID()
  private var polling: Task<Void, Never>?
  private var request: Task<Void, Never>?
  private var rotation: Task<Void, Never>?
  private var rotates = true

  init(
    sync: ChatSync, threadID: String, didRequireUpgrade: @escaping @MainActor (Error) -> Void,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.didRequireUpgrade = didRequireUpgrade
    self.sync = sync
    self.threadID = threadID
    self.sleep = sleep
  }

  func demand(_ next: String?) {
    guard next != runID else { return }
    stop()
    runID = next
    guard let next else { return }
    let owner = generation
    polling = Task { [weak self, sleep] in
      do {
        while !Task.isCancelled {
          guard let self, self.generation == owner else { return }
          self.refresh(runID: next, owner: owner)
          // PWA requests immediately, then on a fixed 15-second cadence.
          try await sleep(.seconds(15))
        }
      } catch {}
    }
  }

  func setRotates(_ enabled: Bool) {
    guard rotates != enabled else { return }
    rotates = enabled
    reconcileRotation()
  }

  func stop() {
    generation = UUID()
    runID = nil
    polling?.cancel()
    request?.cancel()
    rotation?.cancel()
    polling = nil
    request = nil
    rotation = nil
    messages = []
    currentID = nil
  }

  private func refresh(runID: String, owner: UUID) {
    request?.cancel()
    request = Task { [weak self, sync, threadID] in
      do {
        let summary = try await sync.activitySummary(threadID: threadID, runID: runID)
        try Task.checkCancellation()
        guard let self, self.generation == owner else { return }
        self.replace(summary.status == .available ? summary.messages : [])
      } catch {
        guard !Task.isCancelled, let self, self.generation == owner else { return }
        self.replace([])
        if (error as? APIClientError)?.statusCode == 426 { self.didRequireUpgrade(error) }
      }
    }
  }

  private func replace(_ next: [ChatActivitySummary.Message]) {
    let previousCount = messages.count
    messages = next
    if !next.contains(where: { $0.id == currentID }) { currentID = next.first?.id }
    // Retain the current phrase and cadence when the same-size batch refreshes.
    if previousCount != next.count { reconcileRotation() }
  }

  private func reconcileRotation() {
    rotation?.cancel()
    rotation = nil
    guard rotates, messages.count > 1 else { return }
    let owner = generation
    rotation = Task { [weak self, sleep] in
      do {
        while !Task.isCancelled {
          try await sleep(.seconds(5))
          try Task.checkCancellation()
          guard let self, self.generation == owner, self.messages.count > 1 else { return }
          let index = self.messages.firstIndex { $0.id == self.currentID } ?? 0
          self.currentID = self.messages[(index + 1) % self.messages.count].id
        }
      } catch {}
    }
  }
}
