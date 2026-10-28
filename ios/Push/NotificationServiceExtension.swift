import Foundation
import OSLog
import UserNotifications

/// UserNotifications may call from any queue; only the actor-owned delivery
/// state reads callbacks, owns network work and completes an alert.
final class NotificationServiceExtension: UNNotificationServiceExtension {
  private let delivery: NotificationExtensionDelivery

  override init() {
    CrashReporting.start()
    delivery = NotificationExtensionDelivery()
    super.init()
  }

  init(session: NotificationExtensionSession) {
    delivery = NotificationExtensionDelivery(session: session)
    super.init()
  }

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content = NotificationDelivery(content: request.content, handler: contentHandler)
    let delivery = delivery
    Task { @MainActor in delivery.receive(content) }
  }

  override func serviceExtensionTimeWillExpire() {
    let delivery = delivery
    Task { @MainActor in delivery.finish() }
  }
}

@MainActor
private final class NotificationExtensionDelivery {
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNNotificationContent?
  private var work: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var requestID = UUID()
  private let session: NotificationExtensionSession?

  nonisolated init(session: NotificationExtensionSession? = nil) {
    self.session = session
  }

  func receive(_ delivery: NotificationDelivery) {
    finish()
    let id = UUID()
    requestID = id
    content = delivery.content
    handler = delivery.handler
    guard let destination = NotificationDestination(userInfo: delivery.content.userInfo),
      let session = session ?? NotificationExtensionSession.live()
    else {
      finish()
      return
    }
    deadline = Task {
      do { try await Task.sleep(for: .seconds(25)) } catch { return }
      guard requestID == id else { return }
      finish()
    }
    work = Task {
      do { try await session.synchronize(destination) } catch {
        Logger(subsystem: "ai.okou.ios", category: "NotificationExtension")
          .info(
            "Notification delivered with available cache: \(error.localizedDescription, privacy: .public)"
          )
      }
      guard requestID == id else { return }
      finish()
    }
  }

  func finish() {
    let callback = handler
    let original = content
    handler = nil
    content = nil
    work?.cancel()
    deadline?.cancel()
    work = nil
    deadline = nil
    if let callback, let original { callback(original) }
  }

}

// UserNotifications supplies this callback on an arbitrary queue. It is handed
// once to the main actor; all reads and completion calls remain serialized there.
private struct NotificationDelivery: @unchecked Sendable {
  let content: UNNotificationContent
  let handler: (UNNotificationContent) -> Void
}
