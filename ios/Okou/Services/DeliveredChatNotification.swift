import Foundation

struct DeliveredChatNotification: Sendable {
  let identifier: String
  let destination: NotificationDestination
}

struct NotificationStateRequest: Encodable {
  struct Receipt: Encodable {
    let identifier: String
    let threadId: String
    let runId: String
  }
  let notifications: [Receipt]
}

struct NotificationStateResponse: Decodable, Sendable {
  let unreadCount: Int
  let removeIdentifiers: [String]
}
