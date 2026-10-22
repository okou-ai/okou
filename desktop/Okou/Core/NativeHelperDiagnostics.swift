import CryptoKit
import Foundation

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
