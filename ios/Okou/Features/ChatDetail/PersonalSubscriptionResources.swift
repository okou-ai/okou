import CCState
import ChatData
import Foundation
import Observation

/// One read graph per authenticated workspace. Confirmed accounts also serve recovery commands.
@MainActor @Observable
final class PersonalSubscriptionResources {
  struct Group: Sendable {
    let type: PersonalSubscriptionType
    let accounts: [PersonalSubscription]
  }

  let store: CCState.Store
  private let service: PersonalSubscriptionService
  private let now: @Sendable () -> Date
  private let didFail: @MainActor (Error) -> Void
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let reload: Command<Void, Void>
  // This is a confirmed business snapshot, not a second loading/error state.
  private(set) var accounts: [PersonalSubscription] = []
  private(set) var accountRevision = 0
  @ObservationIgnored private var request: (id: UUID, task: Task<[PersonalSubscription], Error>)?
  private var lastRead: Date?
  private var pending = false
  private var closed = false

  init(
    store: CCState.Store, service: PersonalSubscriptionService,
    now: @escaping @Sendable () -> Date = { Date() },
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.store = store
    self.service = service
    self.now = now
    self.didFail = didFail
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  @ObservationIgnored lazy var value = makeValue()

  private func makeValue() -> Computed<Task<[PersonalSubscription], Error>> {
    Computed {
      [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let id = UUID()
      pending = true
      // Failure reporting may close the workspace, so it runs after graph evaluation.
      let task = Task<[PersonalSubscription], Error> { @MainActor [weak self, service] in
        do {
          try Task.checkCancellation()
          let accounts = try await service.list()
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard let self, !closed, request?.id == id else { throw CancellationError() }
          self.accounts = accounts
          accountRevision += 1
          lastRead = now()
          pending = false
          return accounts
        } catch {
          if let self, !closed, request?.id == id {
            pending = false
            if !Task.isCancelled, !signal.isCancelled { didFail(error) }
          }
          throw error
        }
      }
      request = (id, task)
      signal.onCancel { task.cancel() }
      return task
    }
  }

  @ObservationIgnored lazy var groups: Computed<Task<[Group], Error>> = computedTask {
    [value] get, options in
    let pending = try get(value)
    let accounts = try await pending.value
    try Task.checkCancellation()
    try options.signal.checkCancellation()
    return Self.group(accounts)
  }

  var confirmedGroups: [Group] { Self.group(accounts) }

  private static func group(_ accounts: [PersonalSubscription]) -> [Group] {
    PersonalSubscriptionType.allCases.map { type in
      Group(type: type, accounts: accounts.filter { $0.type == type.rawValue })
    }
  }

  /// Waiters follow a superseding read instead of mistaking its invalidation for success.
  func read(force: Bool = false) async throws -> [PersonalSubscription] {
    guard !closed, !Task.isCancelled else { throw CancellationError() }
    let stale = lastRead.map { now().timeIntervalSince($0) >= 60 } ?? true
    if force || (!pending && stale && request != nil) {
      try invalidate()
    }
    while !closed {
      try Task.checkCancellation()
      let task = try store.get(value)
      let id = request?.id
      let result = await task.result
      try Task.checkCancellation()
      guard !closed else { throw CancellationError() }
      if request?.id != id { continue }
      return try result.get()
    }
    throw CancellationError()
  }

  /// Invalidate the shared read without replaying or acknowledging any mutation.
  func invalidate() throws {
    guard !closed else { throw CancellationError() }
    request?.task.cancel()
    try store.set(reload)
  }

  func close() {
    closed = true
    request?.task.cancel()
    request = nil
    accounts = []
    lastRead = nil
    pending = false
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { request?.task.cancel() }
}
