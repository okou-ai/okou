import CryptoKit
import Foundation

/// Captured once. Retries use the original envelope and PNG until the sandbox has both files.
struct DirectAppStateBundle: Sendable {
  let data: Data
  let digest: String
  let snapshotId: String

  init(commandId: String, result: JSONValue) throws {
    let maxBytes = 32 * 1024 * 1024
    let prefix = "data:image/png;base64,"
    guard var fields = result.object,
      let snapshotId = fields["snapshotId"]?.string, UUID(uuidString: snapshotId) != nil,
      fields["appState"]?.string != nil,
      let image = fields.removeValue(forKey: "screenshot")?.string, image.hasPrefix(prefix)
    else { throw DesktopFailure("screen_recording_unavailable", "The window capture is incomplete") }
    guard image.utf8.count <= prefix.count + 4 * ((maxBytes + 2) / 3) else {
      throw DesktopFailure("result_too_large", "The window capture exceeds the transfer size limit")
    }
    guard let png = Data(base64Encoded: String(image.dropFirst(prefix.count))),
      png.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    else { throw DesktopFailure("screen_recording_unavailable", "The window capture has an invalid PNG") }
    let envelope = try JSONEncoder().encode(
      JSONValue.object(["commandId": .string(commandId), "result": .object(fields)]))
    guard envelope.count + png.count + 4 <= maxBytes else {
      throw DesktopFailure("result_too_large", "The window capture exceeds the transfer size limit")
    }
    var length = UInt32(envelope.count).bigEndian
    var data = Data(capacity: 4 + envelope.count + png.count)
    withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
    data.append(envelope)
    data.append(png)
    self.data = data
    self.digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    self.snapshotId = snapshotId
  }

  var receipt: JSONValue {
    .object([
      "status": .string("succeeded"),
      "result": .object(["snapshotId": .string(snapshotId), "sha256": .string(digest)]),
    ])
  }
}

final class DirectAppStateUpload: NSObject, URLSessionTaskDelegate, Sendable {
  private let session: URLSession

  init(configuration: URLSessionConfiguration = .ephemeral) {
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.httpCookieStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func send(
    _ bundle: DirectAppStateBundle, commandId: String,
    target: ComputerUseCommandClaim.Command.AppStateUpload, budget: CommandBudget
  ) async throws -> JSONValue {
    guard let parts = URLComponents(string: target.url), parts.scheme == "https",
      let host = parts.host, !host.isEmpty, parts.port == nil || parts.port == 443,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      let url = parts.url
    else { throw DesktopFailure("permission_denied", "Invalid Runner upload destination") }
    let path = parts.percentEncodedPath.components(separatedBy: "/")
    guard path.count == 8, path[0].isEmpty, path[1] == "runners", UUID(uuidString: path[2]) != nil,
      path[3] == "sandbox", path[4] == "runs", UUID(uuidString: path[5]) != nil,
      path[6] == "app-state", path[7] == commandId, UUID(uuidString: commandId) != nil
    else { throw DesktopFailure("permission_denied", "Invalid Runner command destination") }

    return try await withThrowingTaskGroup(of: JSONValue.self) { group in
      group.addTask {
        try await Task.sleep(for: .seconds(budget.remaining))
        throw DesktopFailure("command_timeout", "The sandbox did not acknowledge this capture in time")
      }
      group.addTask {
        var backoff = Duration.milliseconds(125)
        var checkReceipt = false
        while budget.remaining > 0 {
          try Task.checkCancellation()
          do {
            switch try await self.upload(bundle, to: url, token: target.token, timeout: budget.remaining, checkReceipt: checkReceipt) {
            case .received: return bundle.receipt
            case .missing: checkReceipt = false
            case .pending: checkReceipt = true
            }
          } catch let error as URLError {
            checkReceipt = true
            guard [.networkConnectionLost, .timedOut, .cannotConnectToHost, .notConnectedToInternet,
              .dnsLookupFailed, .cannotFindHost].contains(error.code)
            else {
              try Task.checkCancellation()
              throw DesktopFailure("window_unavailable", "Could not connect to the assigned Runner")
            }
          }
          try await Task.sleep(for: backoff)
          backoff = min(backoff * 2, .seconds(1))
        }
        throw DesktopFailure("command_timeout", "The capture expired before sandbox acknowledgement")
      }
      defer { group.cancelAll() }
      guard let receipt = try await group.next() else { throw CancellationError() }
      return receipt
    }
  }

  private enum Receipt { case received, missing, pending }

  private func upload(
    _ bundle: DirectAppStateBundle, to url: URL, token: String, timeout: TimeInterval, checkReceipt: Bool
  ) async throws -> Receipt
  {
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = checkReceipt ? "GET" : "PUT"
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(bundle.digest, forHTTPHeaderField: "x-okou-content-sha256")
    if !checkReceipt { request.httpBody = bundle.data }
    let (stream, response) = try await session.bytes(for: request, delegate: self)
    guard let response = response as? HTTPURLResponse else {
      throw DesktopFailure("invalid_arguments", "Invalid response from the assigned Runner")
    }
    switch response.statusCode {
    case 200:
      var receipt = Data()
      for try await byte in stream {
        guard receipt.count < 64 else {
          throw DesktopFailure("invalid_arguments", "The sandbox returned an invalid receipt")
        }
        receipt.append(byte)
      }
      guard receipt == Data(bundle.digest.utf8) else {
        throw DesktopFailure("invalid_arguments", "The sandbox receipt does not match this capture")
      }
      return .received
    case 204 where checkReceipt: return .missing
    case 202 where checkReceipt: return .pending
    case 408, 429, 500, 502, 503, 504: return .pending
    case 401, 403, 404, 410:
      throw DesktopFailure("permission_denied", "This command no longer has a Runner upload grant")
    default:
      throw DesktopFailure("window_unavailable", "The assigned Runner rejected the capture (HTTP \(response.statusCode))")
    }
  }
}
