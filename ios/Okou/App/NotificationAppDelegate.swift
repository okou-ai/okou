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
    guard let destination = NotificationDestination(userInfo: userInfo) else {
      completionHandler(.noData)
      return
    }
    let work = Task { await notifications.synchronize(destination) }
    let execution = application.beginBackgroundTask(withName: "Notification synchronization") {
      work.cancel()
    }
    Task {
      let updated = await work.value
      if execution != .invalid { application.endBackgroundTask(execution) }
      completionHandler(updated ? .newData : .noData)
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
