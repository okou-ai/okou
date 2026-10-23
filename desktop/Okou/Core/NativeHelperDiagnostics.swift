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
  let timeout: TimeInterval
  let started: ContinuousClock.Instant

  init(_ request: JSONValue, timeout: TimeInterval) {
    operation = NativeHelperOperation(rawValue: request["kind"].string ?? "") ?? .unknown
    self.timeout = timeout
    started = .now
  }
}

struct NativeHelperReadFragment: Sendable {
  let sequence: Int
  let streamOffset: Int
  let byteCount: Int

  var endOffset: Int { streamOffset + byteCount }
}

final class NativeHelperOutputReader: @unchecked Sendable {
  private let lock = NSLock()
  private var sequence = 0

  func read(_ handle: FileHandle) -> (data: Data, sequence: Int) {
    lock.withLock {
      let data = handle.availableData
      sequence += 1
      return (data, sequence)
    }
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
