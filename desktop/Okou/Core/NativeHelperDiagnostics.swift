import CryptoKit
import Foundation

struct NativeHelperTermination: Sendable {
  let status: Int32
  let reason: String

  init(_ process: Process) {
    status = process.terminationStatus
    switch process.terminationReason {
    case .exit: reason = "exit"
    case .uncaughtSignal: reason = "uncaught_signal"
    @unknown default: reason = "unknown"
    }
  }
}

// Keep diagnostic labels independent of arbitrary helper request names and payloads.
enum NativeHelperOperation: String, Sendable {
  case permissionsState = "permissions.state"
  case requestAccessibility = "permissions.request_accessibility"
  case requestScreenRecording = "permissions.request_screen_recording"
  case probeAutomation = "permissions.probe_automation"
  case listApps = "apps.list"
  case appState = "app.state"
  case openApp = "app.open"
  case click = "element.click"
  case clickPoint = "element.click_point"
  case scroll = "element.scroll"
  case setValue = "element.set_value"
  case performAction = "element.perform_action"
  case typeText = "keyboard.type_text"
  case pressKey = "keyboard.press_key"
  case unknown
}

struct NativeHelperRequestDiagnostics: Sendable {
  let operation: NativeHelperOperation
  let intent: NativeProcess.RequestIntent
  let timeout: TimeInterval
  let started: ContinuousClock.Instant
  let awakeStarted: SuspendingClock.Instant
  var writtenAt: ContinuousClock.Instant?

  var deadline: ContinuousClock.Instant { started.advanced(by: .seconds(timeout)) }

  init(
    _ request: JSONValue, intent: NativeProcess.RequestIntent, timeout: TimeInterval,
    started: ContinuousClock.Instant,
    awakeStarted: SuspendingClock.Instant
  ) {
    operation = NativeHelperOperation(rawValue: request["kind"].string ?? "") ?? .unknown
    self.intent = intent
    self.timeout = timeout
    self.started = started
    self.awakeStarted = awakeStarted
  }
}

struct NativeHelperReadFragment: Sendable {
  let sequence: Int
  let streamOffset: Int
  let byteCount: Int

  var endOffset: Int { streamOffset + byteCount }
}

final class NativeHelperOutputReader: @unchecked Sendable {
  private let readLock = NSLock()
  private let stateLock = NSLock()
  private let now: @Sendable () -> ContinuousClock.Instant
  private var state = NativeHelperOutputState()

  init(now: @escaping @Sendable () -> ContinuousClock.Instant) { self.now = now }

  var snapshot: NativeHelperOutputState { stateLock.withLock { state } }

  func read(_ handle: FileHandle) -> (data: Data, sequence: Int) {
    readLock.withLock {
      let data = handle.availableData
      return stateLock.withLock {
        state.sequence += 1
        state.bytes += data.count
        if !data.isEmpty { state.readAt = now() }
        return (data, state.sequence)
      }
    }
  }
}

struct NativeHelperOutputState: Sendable {
  var sequence = 0
  var bytes = 0
  var readAt: ContinuousClock.Instant?
}

struct NativeHelperTimeoutDiagnostics: Sendable {
  enum Trigger: String, Sendable { case timer, response }

  let trigger: Trigger
  let output: NativeHelperOutputState
  let processedBytes: Int
  let processedAt: ContinuousClock.Instant?
  let observedAt: ContinuousClock.Instant
  let awakeObservedAt: SuspendingClock.Instant
  let detectedAt: ContinuousClock.Instant
  let retiredAt: ContinuousClock.Instant

  func interruption(
    request: NativeHelperRequestDiagnostics, purpose: NativeProcess.Purpose, pendingRequests: Int
  ) -> DesktopFailure.Interruption? {
    let elapsed = request.started.duration(to: observedAt).seconds
    let awake = request.awakeStarted.duration(to: awakeObservedAt).seconds
    guard purpose == .computerUse, request.operation == .permissionsState,
      request.intent == .permissionRefresh || request.intent == .commandPreflight,
      pendingRequests == 1, request.writtenAt != nil,
      request.timeout > 0, request.timeout.isFinite,
      detectedAt >= request.deadline, retiredAt >= detectedAt, observedAt >= retiredAt,
      elapsed.isFinite, awake.isFinite,
      awake >= 0, awake < request.timeout, elapsed >= request.timeout, elapsed > awake
    else { return nil }
    return request.intent == .permissionRefresh
      ? .suspendedPermissionRefresh : .suspendedCommandPreflight
  }
}

struct NativeHelperDiagnostics: Sendable {
  static let maximumResponseBytes = 4 * 1024 * 1024
  static let maximumReadFragments = 256

  let response: Data
  let details: Data

  init(
    response: Data, reason: NativeHelperFailure, generation: Int, pendingIDs: [Int],
    responseStart: Int, reads: [NativeHelperReadFragment], omittedThrough: Int,
    decoderError: Error?, decodeDurationMs: Double
  ) {
    self.response = response.withUnsafeBytes { Data($0.prefix(Self.maximumResponseBytes)) }
    let digest = SHA256.hash(data: response).map { String(format: "%02x", $0) }.joined()
    let responseEnd = responseStart + response.count
    var lines = [
      "formatVersion=1",
      "capturedAt=\(ISO8601DateFormatter().string(from: Date()))",
      "failure=\(reason.rawValue)",
      "helperGeneration=\(generation)",
      "pendingRequestIDs=\(pendingIDs.prefix(64).map(String.init).joined(separator: ","))",
      "pendingRequestIDsTruncated=\(pendingIDs.count > 64)",
      "responseBytes=\(response.count)",
      "capturedResponseBytes=\(self.response.count)",
      "responseTruncated=\(self.response.count != response.count)",
      "responseSHA256=\(digest)",
      "responseExcludesTerminatingNewline=true",
      "decodeDurationMs=\(decodeDurationMs)",
      "readTraceComplete=\(omittedThrough <= responseStart)",
    ]
    if let decoderError {
      // Decoder descriptions may contain app data. Keep them only in this event's attachment.
      let description = String(reflecting: decoderError)
      lines.append("decoderErrorTruncated=\(description.count > 4096)")
      lines.append("decoderError=\(description.prefix(4096))")
    }
    lines.append("readFragmentsInParserOrder:")
    for read in reads where read.endOffset > responseStart && read.streamOffset < responseEnd {
      let start = max(read.streamOffset, responseStart)
      let end = min(read.endOffset, responseEnd)
      lines.append(
        "readSequence=\(read.sequence) responseOffset=\(start - responseStart) readOffset=\(start - read.streamOffset) byteCount=\(end - start) readBytes=\(read.byteCount)"
      )
    }
    details = Data(lines.joined(separator: "\n").utf8)
  }
}
