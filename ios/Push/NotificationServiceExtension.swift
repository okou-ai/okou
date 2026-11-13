import ChatData
import Foundation
import OSLog
import UserNotifications
import WidgetKit

/// UserNotifications may call from any queue; only the actor-owned delivery
/// state reads callbacks, owns network work and completes an alert.
final class NotificationServiceExtension: UNNotificationServiceExtension {
  private let delivery: NotificationExtensionDelivery

  override init() {
    CrashReporting.start()
    delivery = NotificationExtensionDelivery()
    super.init()
  }

  init(session: NotificationExtensionSession, widgets: OkouWidgetSnapshotStore? = nil) {
    delivery = NotificationExtensionDelivery(session: session, widgets: widgets)
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
  private let widgets: OkouWidgetSnapshotStore?

  nonisolated init(
    session: NotificationExtensionSession? = nil, widgets: OkouWidgetSnapshotStore? = nil
  ) {
    self.session = session
    self.widgets = widgets
  }

  func receive(_ delivery: NotificationDelivery) {
    finish()
    let id = UUID()
    requestID = id
    content = delivery.content
    handler = delivery.handler
    guard let destination = NotificationDestination(userInfo: delivery.content.userInfo) else {
      finish()
      return
    }
    markWidgetChatFinished(destination)
    guard let session = session ?? NotificationExtensionSession.live() else {
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

  /// Alerts are sent only for finished and failed runs, so the alerted chat now waits to be
  /// read. The file change needs no network and lands before the alert shows; the reload also
  /// lets the widget's own refresh add a chat its snapshot did not list.
  private func markWidgetChatFinished(_ destination: NotificationDestination) {
    guard let store = widgets ?? OkouWidgetSnapshotStore() else { return }
    var belongs = false
    do {
      try store.update { snapshot in
        belongs = snapshot.belongs(toUser: destination.userId, workspace: destination.workspaceId)
        return belongs ? snapshot.markingFinished(threadID: destination.threadId, at: .now) : nil
      }
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "NotificationExtension")
        .error(
          "Cannot update the widget snapshot: \(error.localizedDescription, privacy: .public)")
    }
    if belongs { WidgetCenter.shared.reloadTimelines(ofKind: OkouWidgetSnapshot.widgetKind) }
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
