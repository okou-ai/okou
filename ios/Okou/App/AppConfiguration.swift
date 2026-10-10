import Foundation

struct AppConfiguration {
  let apiURL: URL
  let webURL: URL
  /// Marketing version sent as `X-Client-Version`. `CFBundleVersion` is a constant build number.
  let appVersion: String

  init(bundle: Bundle = .main) throws {
    guard let api = bundle.object(forInfoDictionaryKey: "APIBaseURL") as? String,
      let apiURL = URL(string: api), apiURL.scheme == "https",
      let web = bundle.object(forInfoDictionaryKey: "WebBaseURL") as? String,
      let webURL = URL(string: web), webURL.scheme == "https"
    else {
      throw ConfigurationError.invalidOrigins
    }
    guard
      let appVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString")
        as? String,
      appVersion.wholeMatch(of: #/[0-9]+\.[0-9]+\.[0-9]+/#) != nil
    else {
      throw ConfigurationError.invalidVersion
    }
    self.apiURL = apiURL
    self.webURL = webURL
    self.appVersion = appVersion
  }

  enum ConfigurationError: LocalizedError {
    case invalidOrigins
    case invalidVersion
    var errorDescription: String? {
      switch self {
      case .invalidOrigins:
        "The app's service configuration is missing. Rebuild with the Okou configuration."
      case .invalidVersion:
        "The app's version is missing or invalid. Rebuild with the Okou configuration."
      }
    }
  }
}
