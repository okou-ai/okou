import ChatData
import ChatDomain
import Foundation

extension ConversationStore {
  struct PendingMessage: Codable, Identifiable {
    let id: String
    let text: String
    let createdAt: Date
    let attachments: [ChatAttachment]
    var document: ChatDraftDocument?
    var modelSelection: ChatModelSelection?
    var reasoningEffort: String?
    var computerAccess: ChatComputerAccess?
    var needsRetry = false

    var message: ChatMessage {
      ChatMessage(
        id: id, role: .user,
        text: text,
        attachments: attachments.map {
          ChatMessageAttachment(
            id: $0.id, filename: $0.filename, contentType: $0.contentType, size: $0.size)
        }, createdAt: createdAt,
        runID: nil, isQueued: false, isError: false,
        userMessage: document.flatMap { draft in
          guard let data = try? JSONEncoder().encode(draft) else { return nil }
          return try? JSONDecoder().decode(ChatUserMessage.self, from: data)
        })
    }
  }

  /// Text of the running run's messages as it streams, before the durable events arrive.
  struct StreamedOutput: Equatable {
    let eventID: String
    let runID: String
    var text: String
    let createdAt: Date
  }

  struct NavigationRequest: Equatable {
    let id = UUID()
    let position: ConversationReadingPosition
  }

  enum DeliveryFailure {
    case notSent(String)
    case unconfirmed
  }

  func deliveryFailureText(_ id: String) -> String {
    if case .notSent(let reason) = deliveryFailures[id] { return reason }
    return String(localized: "Delivery not confirmed")
  }

}
