import Foundation

// Process retirement must remain available when the Swift executor or stdin write is blocked.
final class NativeHelperLifetime: @unchecked Sendable {
  struct Expiration: Sendable {
    let requestID: Int
    let trigger: NativeHelperTimeoutDiagnostics.Trigger
    let detectedAt: ContinuousClock.Instant
    let retiredAt: ContinuousClock.Instant
  }

  private struct Deadline {
    let instant: ContinuousClock.Instant
    let timer: DispatchSourceTimer
  }

  // All process custody and deadline decisions share this lock. No callback waits on the actor.
  private let lock = NSLock()
  private let process: Process
  private let now: @Sendable () -> ContinuousClock.Instant
  private let queue = DispatchQueue(label: "ai.okou.desktop.helper-deadline", qos: .userInitiated)
  private var deadlines: [Int: Deadline] = [:]
  private var closed = false
  private var expiration: Expiration?

  init(process: Process, now: @escaping @Sendable () -> ContinuousClock.Instant) {
    self.process = process
    self.now = now
  }

  var isRunning: Bool { lock.withLock { !closed && process.isRunning } }
  var expired: Bool { lock.withLock { expiration != nil } }
  var termination: NativeHelperTermination { lock.withLock { NativeHelperTermination(process) } }

  func watch(
    _ id: Int, until deadline: ContinuousClock.Instant, onExpiration: @escaping @Sendable () -> Void
  ) -> Bool {
    lock.withLock {
      guard !closed else { return false }
      let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
      timer.setEventHandler { [weak self] in
        if self?.expire(id, detectedBy: .timer) != nil { onExpiration() }
      }
      timer.schedule(deadline: .now() + max(0, now().duration(to: deadline).seconds))
      deadlines[id] = Deadline(instant: deadline, timer: timer)
      timer.resume()
      return true
    }
  }

  func complete(_ id: Int) -> Expiration? {
    lock.withLock {
      if let expiration { return expiration }
      // Completing a response and committing its timeout must be one decision.
      if let deadline = deadlines[id], now() >= deadline.instant {
        return expireLocked(id, detectedBy: .response)
      }
      deadlines.removeValue(forKey: id)?.timer.cancel()
      return nil
    }
  }

  @discardableResult
  func expire(_ id: Int, detectedBy trigger: NativeHelperTimeoutDiagnostics.Trigger) -> Expiration?
  {
    lock.withLock {
      if let expiration { return expiration }
      guard let deadline = deadlines[id], now() >= deadline.instant else { return nil }
      return expireLocked(id, detectedBy: trigger)
    }
  }

  private func expireLocked(
    _ id: Int, detectedBy trigger: NativeHelperTimeoutDiagnostics.Trigger
  ) -> Expiration {
    let detected = now()
    retireLocked()
    let result = Expiration(
      requestID: id, trigger: trigger, detectedAt: detected, retiredAt: now())
    expiration = result
    return result
  }

  func retire() -> Expiration? {
    lock.withLock {
      retireLocked()
      return expiration
    }
  }

  private func retireLocked() {
    guard !closed else { return }
    closed = true
    for deadline in deadlines.values { deadline.timer.cancel() }
    deadlines.removeAll()
    if process.isRunning {
      // Reap this exact owned process before another helper can dispatch input.
      kill(process.processIdentifier, SIGKILL)
      process.waitUntilExit()
    }
  }
}
