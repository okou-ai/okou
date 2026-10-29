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
      options.beforeSend = { event in
        // HostRuntime reports one correlated failure/recovery episode instead of
        // a second SDK HTTPClientError for every failed heartbeat attempt.
        if event.exceptions?.contains(where: { $0.type == "HTTPClientError" }) == true,
          event.request?.method == "POST", let value = event.request?.url,
          let url = URL(string: value)
        {
          let parts = url.path.split(separator: "/")
          if parts.count == 5, parts[0] == "api", parts[1] == "computer-use",
            parts[2] == "hosts", UUID(uuidString: String(parts[3])) != nil,
            parts[4] == "heartbeat"
          {
            return nil
          }
        }
        return event
      }
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
    _ reason: NativeHelperFailure, purpose: NativeProcess.Purpose, generation: Int,
    pendingRequests: Int, stderrBytes: Int,
    responseBytes: Int? = nil, termination: NativeHelperTermination? = nil,
    request: NativeHelperRequestDiagnostics? = nil,
    attachments: NativeHelperDiagnostics? = nil, timeout: NativeHelperTimeoutDiagnostics? = nil
  ) {
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "Native helper failure: \(reason.rawValue)")
    event.fingerprint = ["desktop-native-helper", reason.rawValue]
    event.tags = ["nativeHelperFailure": reason.rawValue]
    var diagnostics: [String: Any] = [
      "purpose": purpose.rawValue, "generation": generation,
      "pendingRequests": pendingRequests, "stderrBytes": stderrBytes,
      "stderrSaturated": stderrBytes == 65_536,
    ]
    if let responseBytes { diagnostics["responseBytes"] = responseBytes }
    if let termination {
      diagnostics["exitStatus"] = termination.status
      diagnostics["terminationReason"] = termination.reason
    }
    if let request {
      diagnostics["operation"] = request.operation.rawValue
      diagnostics["timeoutMs"] = request.timeout * 1000
      let observed = timeout?.observedAt ?? .now
      diagnostics["elapsedMs"] = request.started.duration(to: observed).seconds * 1000
      if let written = request.writtenAt {
        diagnostics["writeElapsedMs"] = request.started.duration(to: written).seconds * 1000
      }
      if let timeout {
        diagnostics["timeoutDetectedBy"] = timeout.trigger.rawValue
        let elapsed = request.started.duration(to: observed).seconds * 1000
        let awakeElapsed = request.awakeStarted.duration(to: timeout.awakeObservedAt).seconds * 1000
        diagnostics["awakeElapsedMs"] = awakeElapsed
        diagnostics["systemSuspendedMs"] = max(0, elapsed - awakeElapsed)
        diagnostics["deadlineDetectedElapsedMs"] =
          request.started.duration(to: timeout.detectedAt).seconds * 1000
        diagnostics["deadlineDetectionOverrunMs"] = max(
          0, request.deadline.duration(to: timeout.detectedAt).seconds * 1000)
        diagnostics["helperRetiredElapsedMs"] =
          request.started.duration(to: timeout.retiredAt).seconds * 1000
        diagnostics["timeoutSettlementDelayMs"] = max(
          0, timeout.detectedAt.duration(to: observed).seconds * 1000)
        diagnostics["deadlineOverrunMs"] = max(
          0, request.deadline.duration(to: observed).seconds * 1000)
        // Stdout counters describe this helper generation, not a particular request.
        diagnostics["stdoutBytesRead"] = timeout.output.bytes
        diagnostics["stdoutBytesProcessed"] = timeout.processedBytes
        if let read = timeout.output.readAt, read >= request.started {
          diagnostics["lastStdoutReadElapsedMs"] = request.started.duration(to: read).seconds * 1000
        }
        if let processed = timeout.processedAt, processed >= request.started {
          diagnostics["lastStdoutProcessedElapsedMs"] =
            request.started.duration(to: processed).seconds * 1000
        }
      }
    }
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

  static func captureHeartbeatEpisode(
    id: String, outcome: HeartbeatDiagnostics.Outcome, context: [String: Any]
  ) {
    let event = Event(level: outcome == .failed ? .error : .info)
    event.message = SentryMessage(formatted: "Desktop host heartbeat \(outcome.rawValue)")
    event.fingerprint = ["desktop-host-heartbeat"]
    event.tags = ["heartbeatOutcome": outcome.rawValue, "heartbeatEpisodeId": id]
    var diagnostics = context
    diagnostics["method"] = "POST"
    diagnostics["pathTemplate"] = "/api/computer-use/hosts/:hostId/heartbeat"
    event.context = ["heartbeat": diagnostics]
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
