import ChatData
import CryptoKit
import Foundation
import UIKit

struct ConnectorProviderRequest {
  let provider: String
  let webURL: URL
  let appURLs: [URL]
  let callbackURL: URL?
  let exchangeURL: URL?
}

enum ConnectorProviderLaunch {
  case opened
  case unavailable
  case code(String)
}

/// Credentials and code exchange belong to the API, including SDK authorization.
@MainActor
protocol ConnectorProviderApplication {
  var dropboxAppKey: String? { get }
  func supports(_ target: ChatConnectorTarget) -> Bool
  func authorize(_ request: ConnectorProviderRequest) async throws -> ConnectorProviderLaunch
  func receive(_ url: URL) -> Bool
}

@MainActor
final class SystemConnectorProviderApplication: ConnectorProviderApplication {
  private var spotify: SpotifyConnectorAuthorization?
  var dropboxAppKey: String? { ConnectorProviderAuthorization.dropboxAppKey }

  func supports(_ target: ChatConnectorTarget) -> Bool {
    if target == .builtin("dropbox") {
      return ConnectorProviderAuthorization.dropboxAppKey != nil
    }
    guard let slug = target.connectorSlug else { return false }
    return ["strava", "tiktok", "spotify"].contains(slug)
  }

  func authorize(_ request: ConnectorProviderRequest) async throws -> ConnectorProviderLaunch {
    if request.provider == "spotify" {
      let authorization = SpotifyConnectorAuthorization()
      spotify = authorization
      defer { if spotify === authorization { spotify = nil } }
      return .code(try await authorization.authorize(request))
    }
    for url in request.appURLs {
      try Task.checkCancellation()
      if url.scheme != "https", !UIApplication.shared.canOpenURL(url) { continue }
      // An HTTPS link must open the associated app or fail, never silently open Safari.
      let options: [UIApplication.OpenExternalURLOptionsKey: Any] =
        url.scheme == "https" ? [.universalLinksOnly: true] : [:]
      if await UIApplication.shared.open(url, options: options) { return .opened }
    }
    return .unavailable
  }

  func receive(_ url: URL) -> Bool { spotify?.receive(url) == true }
}

enum ConnectorProviderAuthorization {
  static var dropboxAppKey: String? {
    guard let key = Bundle.main.object(forInfoDictionaryKey: "DropboxAppKey") as? String,
      !key.isEmpty, !key.contains("$("), registeredScheme("db-\(key)")
    else { return nil }
    return key
  }

  private static func registeredScheme(_ scheme: String) -> Bool {
    let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
    return types?.contains { ($0["CFBundleURLSchemes"] as? [String])?.contains(scheme) == true }
      == true
  }

  @MainActor static func request(
    receipt: ChatConnectorReceipt, target: ChatConnectorTarget, methodID: String, webURL: URL
  ) throws -> ConnectorProviderRequest? {
    guard let authorization = receipt.nativeAppAuthorization else { return nil }
    let provider = authorization.provider
    guard target == .builtin(provider), methodID == "oauth",
      webURL.scheme == "https", webURL.port == nil, webURL.user == nil,
      webURL.password == nil, webURL.fragment == nil,
      var components = URLComponents(url: webURL, resolvingAgainstBaseURL: false)
    else { throw APIClientError.invalidResponse }
    let items = components.queryItems ?? []
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
    let endpoints = [
      "strava": "https://www.strava.com/oauth/mobile/authorize",
      "tiktok": "https://www.tiktok.com/v2/auth/authorize/",
      "dropbox": "https://www.dropbox.com/oauth2/authorize",
      "spotify": "https://accounts.spotify.com/authorize"
    ]
    guard "https://\(webURL.host ?? "")\(webURL.path)" == endpoints[provider],
      value("state") != nil, value("response_type") == "code"
    else { throw APIClientError.invalidResponse }
    let callback = authorization.callbackUrl
    if provider != "strava" {
      guard let callback, callback.absoluteString == value("redirect_uri"),
        callback.user == nil, callback.password == nil, callback.port == nil,
        callback.query == nil, callback.fragment == nil
      else { throw APIClientError.invalidResponse }
    }
    var urls: [URL] = []
    switch provider {
    case "strava":
      components.scheme = "strava"
      components.host = "oauth"
      components.path = "/mobile/authorize"
    case "tiktok":
      guard isCallback(callback, slug: "tiktok"), value("code_challenge") != nil else {
        throw APIClientError.invalidResponse
      }
      components.path = "/opensdk/oauth/"
      components.queryItems = try tiktokParameters(items)
    case "dropbox":
      guard let clientID = value("client_id"),
        callback?.absoluteString == "db-\(clientID)://2/token",
        value("code_challenge") != nil, value("code_challenge_method") == "S256"
      else { throw APIClientError.invalidResponse }
      let names = [
        "code_challenge", "code_challenge_method", "token_access_type", "response_type", "scope"
      ]
      var extra = URLComponents()
      extra.queryItems = items.filter { names.contains($0.name) }
      components.scheme = "dbapi-2"
      components.host = "1"
      components.path = "/connect"
      components.queryItems = [
        URLQueryItem(name: "k", value: clientID), URLQueryItem(name: "s", value: ""),
        URLQueryItem(name: "state", value: value("state")),
        URLQueryItem(name: "extra_query_params", value: extra.percentEncodedQuery)
      ]
      guard let standard = components.url else { throw APIClientError.invalidResponse }
      urls.append(standard)
      components.scheme = "dbapi-8-emm"
    case "spotify":
      guard callback?.absoluteString == "ai.okou.ios://connector-provider/spotify",
        isCallback(authorization.exchangeUrl, slug: "spotify"), value("client_id") != nil
      else { throw APIClientError.invalidResponse }
      return ConnectorProviderRequest(
        provider: provider, webURL: webURL, appURLs: [], callbackURL: callback,
        exchangeURL: authorization.exchangeUrl)
    default: throw APIClientError.invalidResponse
    }
    guard let url = components.url else { throw APIClientError.invalidResponse }
    urls.append(url)
    return ConnectorProviderRequest(
      provider: provider, webURL: webURL, appURLs: urls, callbackURL: callback, exchangeURL: nil)
  }

  @MainActor
  private static func tiktokParameters(_ items: [URLQueryItem]) throws -> [URLQueryItem] {
    guard let client = items.first(where: { $0.name == "client_key" })?.value,
      let scope = items.first(where: { $0.name == "scope" })?.value,
      let bundleID = Bundle.main.bundleIdentifier
    else { throw APIClientError.invalidResponse }
    // OpenSDK 2.5.0's native query contract. Keep its web-only `from=opensdk`
    // bridge out of the fallback, which must return to our registered HTTPS URI.
    let identity = SHA512.hash(data: Data(bundleID.utf8))
      .map { String(format: "%02x", $0) }.joined()
    let names = ["client_key", "scope", "response_type", "state", "redirect_uri", "code_challenge"]
    return items.filter { names.contains($0.name) } + [
      URLQueryItem(name: "request_id", value: UUID().uuidString),
      URLQueryItem(name: "api_version", value: "2.5.0"),
      URLQueryItem(name: "consumer_key", value: client),
      URLQueryItem(name: "app_identity", value: identity),
      URLQueryItem(
        name: "device_platform",
        value: UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"),
      URLQueryItem(name: "permissions", value: scope),
      URLQueryItem(name: "sdk_name", value: "tiktok_sdk_auth"),
      URLQueryItem(name: "use_spark", value: "1"),
      URLQueryItem(name: "hide_nav_bar", value: "1")
    ]
  }

  static func callbackParameters(
    _ url: URL, receipt: ChatConnectorReceipt
  ) -> [String: String]? {
    guard let auth = receipt.nativeAppAuthorization, let expected = auth.callbackUrl,
      let webURL = receipt.authorizationUrl,
      let state = URLComponents(url: webURL, resolvingAgainstBaseURL: false)?.queryItems?
        .first(where: { $0.name == "state" })?.value,
      url.scheme == expected.scheme, url.user == nil, url.password == nil,
      url.port == nil, url.fragment == nil
    else { return nil }
    let matches: Bool
    if auth.provider == "dropbox" {
      matches =
        (url.host == "1" && ["/connect", "/cancel"].contains(url.path))
        || (url.host == "2" && ["/token", "/cancel"].contains(url.path))
    } else {
      matches = auth.provider == "tiktok" && url.host == expected.host && url.path == expected.path
    }
    guard matches,
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      Set(items.map(\.name)).count == items.count,
      items.first(where: { $0.name == "state" })?.value == state
    else { return nil }
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
    if let error = value("error") { return ["state": state, "error": error] }
    let errorCode = value("error_code") ?? value("errCode")
    if auth.provider == "tiktok", let errorCode, errorCode != "0" {
      return ["state": state, "error": "access_denied"]
    }
    if url.path == "/cancel" { return ["state": state, "error": "access_denied"] }
    let code: String?
    if auth.provider == "dropbox", url.host == "1" {
      // Older Dropbox apps return a PKCE code using the documented code marker.
      // An actual access token from the retired implicit flow is never accepted.
      code =
        value("oauth_code")
        ?? (value("oauth_token") == "oauth2code:" ? value("oauth_token_secret") : nil)
    } else {
      code = value("code")
    }
    guard let code, !code.isEmpty else { return nil }
    return ["state": state, "code": code]
  }

  static func isDropboxCancellation(_ url: URL, receipt: ChatConnectorReceipt) -> Bool {
    receipt.nativeAppAuthorization?.provider == "dropbox"
      && url.scheme == receipt.nativeAppAuthorization?.callbackUrl?.scheme
      && ["1", "2"].contains(url.host ?? "") && url.path == "/cancel"
      && url.user == nil && url.password == nil && url.port == nil && url.fragment == nil
  }

  static func isCallback(_ url: URL?, slug: String) -> Bool {
    guard let url else { return false }
    return url.scheme == "https"
      && url.host == Bundle.main.object(forInfoDictionaryKey: "ConnectorCallbackHost") as? String
      && url.path == "/connectors/\(slug)/callback" && url.port == nil
      && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil
  }

  static func isProviderCallback(_ url: URL) -> Bool {
    (url.scheme == "ai.okou.ios" && url.host == "connector-provider" && url.path == "/spotify")
      || (url.scheme == "https"
        && url.host == Bundle.main.object(forInfoDictionaryKey: "ConnectorCallbackHost") as? String
        && url.path == "/connectors/tiktok/callback")
      || (dropboxAppKey.map { url.scheme == "db-\($0)" } == true)
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
    if url.scheme == "ai.okou.ios", url.host == "connector-authorization",
      url.query == nil, url.pathComponents.count == 2,
      let id = UUID(uuidString: url.lastPathComponent)
    {
      return id.uuidString.lowercased()
    }
    return nil
  }
}
