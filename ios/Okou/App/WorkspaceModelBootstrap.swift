import Foundation

/// Coordinates model baselines across startup and recovery, with bounded HTTP availability.
@MainActor
final class WorkspaceModelBootstrap {
  private enum Phase { case waiting, http, subscribed, closed }
  private var phase = Phase.waiting
  private var started = false
  private var readBeforeSubscriptions = false
  private var subscribedOnce = false
  private var recovering = false
  private var revision = 0
  private var scheduledRevision = 0
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
    case .http, .subscribed: break
    case .closed: throw CancellationError()
    case .waiting:
      startDeadline()
      try await withCheckedThrowingContinuation { continuation in
        waiters.append(continuation)
      }
      try Task.checkCancellation()
    }
    if phase == .http { readBeforeSubscriptions = true }
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

  /// Foreground and transport recovery share one pending model baseline.
  func beginRecovery() {
    guard phase != .closed, !recovering else { return }
    recovering = true
    revision += 1
    readBeforeSubscriptions = false
    deadline?.cancel()
    deadline = nil
    phase = .waiting
  }

  func connectionChanged(_ status: RealtimeConnectionStatus) {
    if status == .connected {
      _ = subscriptionsReady()
    } else if subscribedOnce {
      beginRecovery()
    } else if status == .unavailable || status == .disconnected {
      allowHTTP()
    }
  }

  var needsRecoveryRead: Bool { revision != scheduledRevision }

  func didScheduleRead() { scheduledRevision = revision }

  /// A read released before attachment needs a fresh baseline after the subscription gap closes.
  func subscriptionsReady() -> Bool {
    guard phase != .closed else { return false }
    subscribedOnce = true
    recovering = false
    switch phase {
    case .waiting:
      release(.subscribed)
    case .http:
      if readBeforeSubscriptions { revision += 1 }
      readBeforeSubscriptions = false
      phase = .subscribed
    case .subscribed, .closed: break
    }
    return needsRecoveryRead
  }

  func allowHTTP() {
    guard phase == .waiting else { return }
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
