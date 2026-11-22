import ChatDomain
import Foundation
import OSLog

extension ChatSync {
  public func pendingPrefetchReports() async throws -> [(
    id: Int, report: NotificationPrefetchReport
  )] {
    try await cache?.prefetchReports() ?? []
  }

  public func acknowledgePrefetchReport(_ id: Int) async throws {
    try await cache?.acknowledgePrefetchReport(id)
  }

  public func cachedComposerLocation() async -> LegacyComposerLocation? {
    do {
      return try await cache?.loadNavigation()
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.navigation.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return nil
    }
  }

  public func cachedProjects() async -> [ChatProject]? {
    do { return try await cache?.loadProjects() } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.projects.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return nil
    }
  }

  public func persistProjects(_ projects: [ChatProject]) async {
    do {
      try Task.checkCancellation()
      try await cache?.saveProjects(projects)
    } catch is CancellationError {
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.projects.save.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
    }
  }

}
