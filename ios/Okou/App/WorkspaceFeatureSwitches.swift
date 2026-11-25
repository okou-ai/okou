import ChatData
import Observation

/// The app can present the last server-confirmed switches while the shared endpoint refreshes.
@MainActor @Observable
final class WorkspaceFeatureSwitches {
  private(set) var current: SidebarFeatureSwitches?
  @ObservationIgnored var didRequireUpgrade: (@MainActor (Error) -> Void)?
  private let sync: ChatSync
  private let service: ChatModelService
  @ObservationIgnored private var restoration: Task<Void, Never>?

  init(sync: ChatSync, service: ChatModelService, lifecycleTasks: LifecycleTasks) {
    self.sync = sync
    self.service = service
    let task = Task { [weak self] in
      let cached = await sync.cachedFeatureSwitches()
      guard let self, !Task.isCancelled, current == nil else { return }
      current = cached
    }
    restoration = task
    lifecycleTasks.track(task)
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
    current = confirmed
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
    current = nil
  }
}
