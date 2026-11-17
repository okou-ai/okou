import OSLog
import UIKit
import UserNotifications

final class NotificationAppDelegate: NSObject, UIApplicationDelegate,
  UNUserNotificationCenterDelegate
{
  let notifications: NotificationService

  override init() {
    notifications = NotificationService()
    super.init()
  }
  init(notifications: NotificationService) {
    self.notifications = notifications
    super.init()
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(
    _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = connectingSceneSession.configuration
    configuration.delegateClass = NewChatSceneDelegate.self
    return configuration
  }

  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    notifications.didRegister(deviceToken: deviceToken)
  }

  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    notifications.registrationFailed(error)
  }

  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    let delivery = UUID().uuidString
    let started = ContinuousClock.now
    let log = Logger(subsystem: "ai.okou.ios", category: "Notifications")
    @Sendable func record(_ stage: String) {
      log.info(
        "event=notification.background.completion delivery=\(delivery, privacy: .public) stage=\(stage, privacy: .public) elapsed=\(started.duration(to: .now).description, privacy: .public)"
      )
    }
    record("received")
    guard let destination = NotificationDestination(userInfo: userInfo) else {
      record("invalid-payload-completion-started")
      completionHandler(.noData)
      record("invalid-payload-completion-returned")
      return
    }
    let work = Task {
      record("synchronization-started")
      let updated = await notifications.synchronize(destination)
      record(updated ? "synchronization-saved" : "synchronization-no-data")
      return updated
    }
    record("assertion-acquisition-started")
    let execution = application.beginBackgroundTask(withName: "Notification synchronization") {
      record("assertion-expired")
      work.cancel()
    }
    record(execution == .invalid ? "assertion-unavailable" : "assertion-acquired")
    Task {
      record("join-started")
      let updated = await work.value
      record("join-returned")
      if execution != .invalid {
        record("assertion-release-started")
        application.endBackgroundTask(execution)
        record("assertion-release-returned")
      }
      record("completion-started")
      completionHandler(updated ? .newData : .noData)
      record("completion-returned")
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    guard
      let destination = NotificationDestination(
        userInfo: response.notification.request.content.userInfo)
    else { return }
    await notifications.receiveTap(destination)
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    guard let destination = NotificationDestination(userInfo: notification.request.content.userInfo)
    else { return [] }
    let options = await notifications.foregroundOptions(for: destination)
    _ = await notifications.synchronize(destination)
    return options
  }
}
