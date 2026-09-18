import Foundation

struct AppConfiguration {
  let apiURL: URL
  let webURL: URL

  init(bundle: Bundle = .main) throws {
    guard let api = bundle.object(forInfoDictionaryKey: "APIBaseURL") as? String,
      let apiURL = URL(string: api), apiURL.scheme == "https",
      let web = bundle.object(forInfoDictionaryKey: "WebBaseURL") as? String,
      let webURL = URL(string: web), webURL.scheme == "https"
    else {
      throw ConfigurationError.invalidOrigins
    }
    self.apiURL = apiURL
    self.webURL = webURL
  }

  enum ConfigurationError: LocalizedError {
    case invalidOrigins
    var errorDescription: String? {
      "The app's service configuration is missing. Rebuild with the Okou configuration."
    }
  }
}
