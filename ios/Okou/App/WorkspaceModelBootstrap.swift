import Foundation

/// One workspace's model reads wait for the initial subscriptions, with bounded HTTP availability.
@MainActor
final class WorkspaceModelBootstrap {
  private enum Phase { case waiting, http, subscribed, closed }
  private var phase = Phase.waiting
  private var started = false
  private var readBeforeSubscriptions = false
  private var waiters: [CheckedContinuation<Void, Error>] = []
  private var deadline: Task<Void, Never>?
  private let waitForTimeout: @Sendable () async throws -> Void

  init(
    waitForTimeout: @escaping @Sendable () async throws -> Void = {
      try await Task.sleep(for: .seconds(1))
    }
  ) {
    self.waitForTimeout = waitForTimeout
  }

  func wait() async throws {
    try Task.checkCancellation()
    switch phase {
    case .http, .subscribed: return
    case .closed: throw CancellationError()
    case .waiting:
      startDeadline()
      try await withCheckedThrowingContinuation { continuation in
        waiters.append(continuation)
      }
      try Task.checkCancellation()
    }
  }

  private func startDeadline() {
    guard deadline == nil else { return }
    deadline = Task { [weak self, waitForTimeout] in
      do {
        try await waitForTimeout()
        try Task.checkCancellation()
      } catch { return }
      self?.allowHTTP()
    }
  }

  /// Restarting an existing workspace still revalidates its previously loaded configuration.
  func beginStartup() -> Bool {
    let revalidate = started
    started = true
    return revalidate
  }

  /// A read released before attachment needs a fresh baseline after the subscription gap closes.
  func subscriptionsReady() -> Bool {
    switch phase {
    case .waiting:
      release(.subscribed)
      return false
    case .http:
      phase = .subscribed
      return true
    case .subscribed: return readBeforeSubscriptions
    case .closed: return false
    }
  }

  func allowHTTP() {
    guard phase == .waiting else { return }
    readBeforeSubscriptions = true
    release(.http)
  }

  private func release(_ phase: Phase) {
    self.phase = phase
    deadline?.cancel()
    deadline = nil
    let pending = waiters
    waiters.removeAll()
    for waiter in pending { waiter.resume() }
  }

  func close() {
    phase = .closed
    deadline?.cancel()
    deadline = nil
    let pending = waiters
    waiters.removeAll()
    for waiter in pending { waiter.resume(throwing: CancellationError()) }
  }

  isolated deinit {
    deadline?.cancel()
    for waiter in waiters { waiter.resume(throwing: CancellationError()) }
  }
}
