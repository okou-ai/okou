import Foundation

/// Clerk user and organization IDs are opaque and case-sensitive.
public struct WorkspaceMemberID: Hashable, Sendable {
  public let userID: String
  public let workspaceID: String

  public init(userID: String, workspaceID: String) {
    self.userID = userID
    self.workspaceID = workspaceID
  }

  init?(permissionQuery: [URLQueryItem]) {
    func identifier(_ key: String) -> String? {
      let items = permissionQuery.filter { $0.name == key }
      guard items.count == 1, let value = items[0].value, !value.isEmpty,
        value == value.trimmingCharacters(in: .whitespacesAndNewlines)
      else { return nil }
      return value
    }
    guard let user = identifier("userId"), let workspace = identifier("orgId") else { return nil }
    self.init(userID: user, workspaceID: workspace)
  }
}
