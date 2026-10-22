import Foundation
import OSLog
import Sentry

public enum DesktopTelemetry {
  public static func start(
    dsn: String?, version: String?, environment: String, cacheDirectory: URL
  ) {
    guard let dsn, !dsn.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      Logger(subsystem: "ai.okou.desktop", category: "telemetry").error(
        "Desktop error reporting is disabled because the Sentry DSN is missing")
      return
    }
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = version.map { "okou-desktop@\($0)" }
      options.environment = environment
      options.cacheDirectoryPath = cacheDirectory.path
      options.maxAttachmentSize = 5 * 1024 * 1024
      options.sendDefaultPii = false
      options.tracesSampleRate = 0
      options.enableAutoPerformanceTracing = false
      options.enableAutoBreadcrumbTracking = false
      options.enableNetworkTracking = false
      options.enableNetworkBreadcrumbs = false
      options.enableUncaughtNSExceptionReporting = true
      options.appHangTimeoutInterval = 5
      options.initialScope = { scope in
        scope.setTag(value: "desktop", key: "app")
        scope.setTag(value: "desktop-main", key: "component")
        return scope
      }
    }
  }

  static func captureHelperFailure(
    _ reason: NativeHelperFailure, pendingRequests: Int, stderrBytes: Int,
    responseBytes: Int? = nil, exitStatus: Int32? = nil,
    attachments: NativeHelperDiagnostics? = nil
  ) {
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "Native helper failure: \(reason.rawValue)")
    event.fingerprint = ["desktop-native-helper", reason.rawValue]
    event.tags = ["nativeHelperFailure": reason.rawValue]
    var diagnostics: [String: Any] = [
      "pendingRequests": pendingRequests, "stderrBytes": stderrBytes,
      "stderrSaturated": stderrBytes == 65_536,
    ]
    if let responseBytes { diagnostics["responseBytes"] = responseBytes }
    if let exitStatus { diagnostics["exitStatus"] = exitStatus }
    if reason == .invalidJSON || reason == .missingRequestID {
      diagnostics["diagnosticAttachments"] = attachments == nil ? "rate_limited" : "included"
    }
    event.context = ["nativeHelper": diagnostics]
    SentrySDK.capture(event: event) { scope in
      if let attachments {
        scope.addAttachment(
          Attachment(data: attachments.response, filename: "native-helper-response.bin"))
        scope.addAttachment(
          Attachment(
            data: attachments.details, filename: "native-helper-diagnostics.txt",
            contentType: "text/plain"))
      }
    }
  }

  public static func captureStartupFailure() {
    // Startup errors can contain local paths, provider responses, or account information.
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "Desktop startup failed")
    event.fingerprint = ["desktop-startup"]
    SentrySDK.capture(event: event)
  }

  public static func close() { SentrySDK.close() }
}

enum NativeHelperFailure: String {
  case launch = "launch_failed"
  case write = "write_failed"
  case invalidJSON = "invalid_json"
  case missingRequestID = "missing_request_id"
  case responseLimit = "response_limit"
  case timeout
  case unexpectedExit = "unexpected_exit"
}
