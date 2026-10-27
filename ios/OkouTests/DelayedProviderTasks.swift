import Foundation
import Synchronization
import XCTest

final class DelayedProviderTasks: Sendable {
  private struct Request: Sendable {
    let task: Task<Void, Never>
    let gate: AsyncStream<Void>.Continuation
    let progress: Progress
  }
  private struct State: Sendable {
    var requests: [Request] = []
    var released = false
    var closed = false
  }
  private let state = Mutex(State())

  @MainActor
  init(owner: XCTestCase) {
    owner.addTeardownBlock { await self.close() }
  }

  func hold(
    onCancel: @escaping @Sendable () -> Void = {},
    _ completion: @escaping @Sendable () -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    let cancelled = Mutex(false)
    progress.cancellationHandler = {
      let first = cancelled.withLock { value in
        defer { value = true }
        return !value
      }
      if first { onCancel() }
    }
    state.withLock { state in
      guard !state.closed else {
        progress.cancel()
        return
      }
      let (stream, gate) = AsyncStream<Void>.makeStream()
      if state.released {
        gate.yield()
        gate.finish()
      }
      let task = Task {
        for await _ in stream { break }
        guard !Task.isCancelled else { return }
        completion()
      }
      state.requests.append(Request(task: task, gate: gate, progress: progress))
    }
    return progress
  }

  func release() {
    let requests = state.withLock { state in
      state.released = true
      return state.requests
    }
    for request in requests {
      request.gate.yield()
      request.gate.finish()
    }
  }

  private func close() async {
    let requests = state.withLock { state in
      state.closed = true
      defer { state.requests.removeAll() }
      return state.requests
    }
    for request in requests {
      request.progress.cancel()
      request.task.cancel()
      request.gate.finish()
    }
    for request in requests { await request.task.value }
  }
}
