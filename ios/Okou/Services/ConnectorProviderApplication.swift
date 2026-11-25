import ChatData
import Foundation
import UIKit

/// The installed-app boundary. Provider credentials and callback exchange stay at the API.
@MainActor
protocol ConnectorProviderApplication {
  func open(_ url: URL) async -> Bool
}

struct SystemConnectorProviderApplication: ConnectorProviderApplication {
  func open(_ url: URL) async -> Bool {
    guard UIApplication.shared.canOpenURL(url) else { return false }
    return await UIApplication.shared.open(url, options: [:])
  }
}

enum ConnectorProviderAuthorization {
  static func appURL(
    receipt: ChatConnectorReceipt, target: ChatConnectorTarget, methodID: String, webURL: URL
  ) throws -> URL? {
    guard let authorization = receipt.nativeAppAuthorization else { return nil }
    guard authorization.provider == "strava", target == .builtin("strava"), methodID == "oauth",
      webURL.scheme == "https", webURL.host == "www.strava.com", webURL.port == nil,
      webURL.path == "/oauth/mobile/authorize", webURL.user == nil, webURL.password == nil,
      var components = URLComponents(url: webURL, resolvingAgainstBaseURL: false)
    else { throw APIClientError.invalidResponse }
    // This is Strava's documented mobile endpoint, with the exact server-owned
    // client, state, registered HTTPS callback and scope query left intact.
    components.scheme = "strava"
    components.host = "oauth"
    components.path = "/mobile/authorize"
    guard let url = components.url else { throw APIClientError.invalidResponse }
    return url
  }

  static func validateCallback(_ receipt: ChatConnectorReceipt) throws {
    guard let url = receipt.nativeCallbackUrl else { return }
    guard url.scheme == "https", let id = returnAttemptID(url),
      id == receipt.oauthAttemptId?.lowercased()
    else { throw APIClientError.invalidResponse }
  }

  static func returnAttemptID(_ url: URL) -> String? {
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
