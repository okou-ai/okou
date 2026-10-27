import Foundation

struct NotificationDestination: Decodable, Hashable, Sendable {
  let version: Int
  let userId: String
  let workspaceId: String
  let threadId: String
  let runId: String
  let notificationId: String

  init?(userInfo: [AnyHashable: Any]) {
    guard let value = userInfo["okou"], JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value),
      let destination = try? JSONDecoder().decode(Self.self, from: data),
      destination.version == 1, !destination.userId.isEmpty, !destination.workspaceId.isEmpty,
      UUID(uuidString: destination.threadId) != nil, UUID(uuidString: destination.runId) != nil,
      !destination.notificationId.isEmpty
    else { return nil }
    self = destination
  }
}
