import Photos
import Synchronization

/// PhotoKit acquisition and cancellation share one synchronized native manager.
final class PhotoLibraryImageManager: Sendable {
  private let manager: Mutex<PHImageManager>

  init(_ manager: sending PHImageManager = PHCachingImageManager()) {
    self.manager = Mutex(manager)
  }

  @MainActor
  func read<Value: Sendable>(
    _ start: (PHImageManager, @escaping @Sendable (Result<Value, Error>) -> Void) ->
      PHImageRequestID
  ) async throws -> Value {
    try await PhotoLibraryImageRequest<Value>.read(
      start: { complete in manager.withLock { start($0, complete) } },
      cancel: { [self] id in manager.withLock { $0.cancelImageRequest(id) } })
  }
}

/// One callback request completes exactly once, including cancellation before its ID arrives.
final class PhotoLibraryImageRequest<Value: Sendable>: Sendable {
  private struct State {
    var continuation: CheckedContinuation<Value, Error>?
    var requestID: PHImageRequestID?
    var cancelled = false
    var finished = false
  }

  private let state = Mutex(State())
  private let cancelRequest: @Sendable (PHImageRequestID) -> Void

  private init(cancel: @escaping @Sendable (PHImageRequestID) -> Void) {
    cancelRequest = cancel
  }

  @MainActor
  static func read(
    start: (@escaping @Sendable (Result<Value, Error>) -> Void) -> PHImageRequestID,
    cancel: @escaping @Sendable (PHImageRequestID) -> Void
  ) async throws -> Value {
    let request = PhotoLibraryImageRequest(cancel: cancel)
    let value = try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        guard request.begin(continuation) else { return }
        let id = start { request.finish($0) }
        request.register(id)
      }
    } onCancel: {
      request.cancel()
    }
    try Task.checkCancellation()
    return value
  }

  private func begin(_ continuation: CheckedContinuation<Value, Error>) -> Bool {
    let acquired = state.withLock { state in
      guard !state.cancelled else { return false }
      state.continuation = continuation
      return true
    }
    if !acquired { continuation.resume(throwing: CancellationError()) }
    return acquired
  }

  private func register(_ id: PHImageRequestID) {
    let cancelled = state.withLock { state in
      if state.cancelled { return true }
      if !state.finished { state.requestID = id }
      return false
    }
    if cancelled { cancelRequest(id) }
  }

  private func finish(_ result: Result<Value, Error>) {
    let continuation = state.withLock { state in
      guard !state.finished else { return nil as CheckedContinuation<Value, Error>? }
      state.finished = true
      state.requestID = nil
      defer { state.continuation = nil }
      return state.continuation
    }
    // Neither an SDK callback nor a continuation resumes while the state lock is held.
    continuation?.resume(with: result)
  }

  private func cancel() {
    let retired = state.withLock { state in
      guard !state.finished else {
        return nil as (CheckedContinuation<Value, Error>?, PHImageRequestID?)?
      }
      state.cancelled = true
      state.finished = true
      defer {
        state.continuation = nil
        state.requestID = nil
      }
      return (state.continuation, state.requestID)
    }
    guard let (continuation, id) = retired else { return }
    continuation?.resume(throwing: CancellationError())
    if let id { cancelRequest(id) }
  }
}
