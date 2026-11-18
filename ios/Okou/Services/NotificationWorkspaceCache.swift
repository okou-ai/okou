import ChatData
import Foundation

/// Reuses the prepared transport/cache graph only within its immutable authenticated scope.
@MainActor
final class NotificationWorkspaceCache {
  private var preparedWorkspace: NotificationWorkspace?

  func data(
    authentication: AuthenticationService, configuration: AppConfiguration, session: URLSession
  ) -> NotificationWorkspace? {
    guard let scopeID = authentication.presentationScopeID, let userID = authentication.userID,
      let workspaceID = authentication.presentationWorkspaceID
    else {
      preparedWorkspace = nil
      return nil
    }
    if let preparedWorkspace, preparedWorkspace.scopeID == scopeID { return preparedWorkspace }
    let client = APIClient(
      baseURL: configuration.apiURL, clientVersion: configuration.appVersion, session: session
    ) {
      try await authentication.accessToken(workspaceID: workspaceID, scopeID: scopeID)
    }
    let sharedDirectory = PushConfiguration.directory()
    let cache = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: configuration.apiURL, userID: userID, workspaceID: workspaceID),
      directory: sharedDirectory,
      migratingFrom: sharedDirectory == nil
        ? nil
        : FileManager.default.urls(
          for: .applicationSupportDirectory, in: .userDomainMask
        ).first)
    let data = NotificationWorkspace(
      scopeID: scopeID, userID: userID, workspaceID: workspaceID, client: client,
      sync: ChatSync(client: client, cache: cache), cache: cache)
    preparedWorkspace = data
    return data
  }
}
