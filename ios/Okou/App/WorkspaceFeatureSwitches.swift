import CCState
import ChatData

/// The app can present the last server-confirmed switches while the shared endpoint refreshes.
/// They are kept in the workspace session's Store: the model snapshot that views resolve reads
/// `confirmedValue`, and `current` serves owner logic and tests.
@MainActor
final class WorkspaceFeatureSwitches {
  /// The last confirmed switches. The payload is not Equatable, so each confirmation is a new
  /// revision.
  struct Confirmed: Equatable {
    let switches: SidebarFeatureSwitches?
    let revision: Int

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.revision == rhs.revision }
  }

  var didRequireUpgrade: (@MainActor (Error) -> Void)?
  let confirmedValue: Computed<Confirmed>
  private let confirmed = CCState.State(Confirmed(switches: nil, revision: 0))
  private let store: CCState.Store
  private let sync: ChatSync
  private let service: ChatModelService
  private var restoration: Task<Void, Never>?

  init(
    sync: ChatSync, service: ChatModelService, store: CCState.Store,
    lifecycleTasks: LifecycleTasks
  ) {
    self.sync = sync
    self.service = service
    self.store = store
    let confirmed = confirmed
    confirmedValue = Computed { try $0(confirmed) }
    let task = Task { [weak self] in
      let cached = await sync.cachedFeatureSwitches()
      guard let self, !Task.isCancelled, current == nil else { return }
      publish(cached)
    }
    restoration = task
    lifecycleTasks.track(task)
  }

  var current: SidebarFeatureSwitches? {
    // A synchronous local value, not a network or persistence boundary.
    do { return try store.get(confirmedValue).switches } catch {
      preconditionFailure("Cannot read the confirmed feature switches: \(error)")
    }
  }

  func refresh() async throws -> SidebarFeatureSwitches {
    let confirmed: SidebarFeatureSwitches
    do {
      confirmed = try await service.featureSwitches()
    } catch {
      if !Task.isCancelled, (error as? APIClientError)?.statusCode == 426 {
        didRequireUpgrade?(error)
      }
      throw error
    }
    try Task.checkCancellation()
    publish(confirmed)
    await sync.persistFeatureSwitches(confirmed)
    try Task.checkCancellation()
    return confirmed
  }

  func available(whileRefreshing refresh: Task<SidebarFeatureSwitches, Error>) async throws
    -> SidebarFeatureSwitches
  {
    if current == nil { await restoration?.value }
    try Task.checkCancellation()
    if let current { return current }
    return try await refresh.value
  }

  func close() {
    restoration?.cancel()
    restoration = nil
    publish(nil)
  }

  private func publish(_ switches: SidebarFeatureSwitches?) {
    do {
      let revision = try store.get(confirmed).revision + 1
      try store.set(confirmed, Confirmed(switches: switches, revision: revision))
    } catch {
      preconditionFailure("Cannot publish the confirmed feature switches: \(error)")
    }
  }
}
