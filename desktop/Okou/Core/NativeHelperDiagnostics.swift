import Foundation

struct NativeHelperDiagnostics: Sendable {
  static let maximumResponseBytes = 4 * 1024 * 1024

  let response: Data
  let details: Data

  init(
    response: Data, reason: NativeHelperFailure, generation: Int, pendingIDs: [Int],
    decoderError: Error?
  ) {
    self.response = response.withUnsafeBytes { Data($0.prefix(Self.maximumResponseBytes)) }
    var lines = [
      "formatVersion=2",
      "failure=\(reason.rawValue)",
      "helperGeneration=\(generation)",
      "pendingRequestIDs=\(pendingIDs.prefix(64).map(String.init).joined(separator: ","))",
      "pendingRequestIDsTruncated=\(pendingIDs.count > 64)",
      "responseBytes=\(response.count)",
      "capturedResponseBytes=\(self.response.count)",
      "responseTruncated=\(self.response.count != response.count)",
      "responseExcludesTerminatingNewline=true",
    ]
    if let decoderError {
      // Decoder descriptions may contain app data. Keep them only in this event's attachment.
      let description = String(reflecting: decoderError)
      lines.append("decoderErrorTruncated=\(description.count > 4096)")
      lines.append("decoderError=\(description.prefix(4096))")
    }
    details = Data(lines.joined(separator: "\n").utf8)
  }
}
