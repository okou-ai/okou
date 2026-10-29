import Foundation
import Sentry

enum CrashReporting {
  static func start(bundle: Bundle = .main) {
    guard NSClassFromString("XCTestCase") == nil,
      let dsn = bundle.object(forInfoDictionaryKey: "SentryDSN") as? String,
      !dsn.isEmpty,
      let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
      let identifier = bundle.bundleIdentifier
    else { return }

    let isExtension = bundle.object(forInfoDictionaryKey: "NSExtension") != nil
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = "okou-ios@\(version)"
      options.dist = build
      #if DEBUG
        options.environment = "development"
      #else
        options.environment = "production"
      #endif
      options.enableCrashHandler = true
      options.enableAutoSessionTracking = !isExtension
      options.enableWatchdogTerminationTracking = !isExtension
      // Crash reporting must not collect chat content, signed URLs, or credentials.
      options.sendDefaultPii = false
      options.tracesSampleRate = 0
      options.enableAutoPerformanceTracing = false
      options.enableAutoBreadcrumbTracking = false
      options.enableNetworkTracking = false
      options.enableNetworkBreadcrumbs = false
      options.enableCaptureFailedRequests = false
      options.enableAppHangTracking = false
      options.enableLogs = false
      options.attachScreenshot = false
      options.attachViewHierarchy = false
      options.initialScope = { scope in
        scope.setTag(value: "ios", key: "app")
        scope.setTag(value: identifier, key: "component")
        return scope
      }
    }
  }
}
