import ChatData
import Foundation

enum ConnectorAuthorizationReturn {
  static func validateCallback(_ receipt: ChatConnectorReceipt) throws {
    guard let url = receipt.nativeCallbackUrl else { return }
    guard url.scheme == "https", let id = attemptID(url),
      id == receipt.oauthAttemptId?.lowercased()
    else { throw APIClientError.invalidResponse }
  }

  static func attemptID(_ url: URL) -> String? {
    guard url.user == nil, url.password == nil, url.port == nil, url.fragment == nil else {
      return nil
    }
    if url.scheme == "https",
      url.host == Bundle.main.object(forInfoDictionaryKey: "ConnectorCallbackHost") as? String,
      url.path == "/native/connector-authorization",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.count == 1, items[0].name == "attemptId", let value = items[0].value,
      let id = UUID(uuidString: value)
    {
      return id.uuidString.lowercased()
    }
    // An explicit link on the browser recovery page also works when iOS keeps
    // a Universal Link in Safari. It only resumes the matching active attempt.
    if url.scheme == "ai.okou.ios", url.host == "connector-authorization",
      url.query == nil, url.pathComponents.count == 2,
      let id = UUID(uuidString: url.lastPathComponent)
    {
      return id.uuidString.lowercased()
    }
    return nil
  }
}
