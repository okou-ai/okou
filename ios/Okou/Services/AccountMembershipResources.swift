import CCState
import ChatData
import Foundation
import OSLog
import Observation

/// Account/session reads survive workspace replacement. AuthenticationService owns SDK authority.
@MainActor @Observable
final class AccountMembershipResources {
  struct Scope: Equatable {
    let environment: String
    let userID: String
    let sessionID: String
  }

  struct Page {
    let workspaces: [WorkspacePresentation]
    let totalCount: Int
  }

  let scope: Scope
  let store = CCState.Store()
  private let readPage: @MainActor (Int) async throws -> Page
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  // Complete SDK-confirmed membership is needed for activation and display persistence.
  // It is neither a request phase nor an authorization grant or a persisted-name cache.
  private(set) var confirmed: [WorkspacePresentation]?
  @ObservationIgnored private var request: Task<[WorkspacePresentation], Error>?
  private var pending = false
  private var closed = false

  init(scope: Scope, readPage: @escaping @MainActor (Int) async throws -> Page) {
    self.scope = scope
    self.readPage = readPage
    let revision = revision
    let lifetime = lifetime
    reload = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(revision, update: { $0 + 1 })
    }
  }

  @ObservationIgnored lazy var value = makeValue()

  private func makeValue() -> Computed<Task<[WorkspacePresentation], Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      pending = true
      let task = Task { @MainActor [weak self, readPage] in
        defer { if let self, !closed, !signal.isCancelled { pending = false } }
        var workspaces: [WorkspacePresentation] = []
        var page = 1
        while true {
          try Task.checkCancellation()
          try signal.checkCancellation()
          let response = try await readPage(page)
          try Task.checkCancellation()
          try signal.checkCancellation()
          workspaces.append(contentsOf: response.workspaces)
          if response.workspaces.isEmpty || workspaces.count >= response.totalCount { break }
          page += 1
        }
        guard let self, !closed else { throw CancellationError() }
        confirmed = workspaces
        return workspaces
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Refresh/retry invalidates a settled read; overlapping demand shares the original pagination.
  func read(refresh: Bool = false) async throws -> [WorkspacePresentation] {
    guard !closed else { throw CancellationError() }
    try Task.checkCancellation()
    if refresh, request != nil, !pending { try store.set(reload) }
    let task = try store.get(value)
    let workspaces = try await task.value
    // A cancelled waiter detaches without cancelling another consumer's original I/O.
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    return workspaces
  }

  func close() {
    guard !closed else { return }
    closed = true
    request?.cancel()
    request = nil
    confirmed = nil
    pending = false
    do { try store.set(lifetime, false) } catch {
      Logger(subsystem: "ai.okou.ios", category: "AccountMembershipResources")
        .error("Cannot close membership graph: \(error.localizedDescription, privacy: .public)")
    }
  }

  isolated deinit { request?.cancel() }
}
