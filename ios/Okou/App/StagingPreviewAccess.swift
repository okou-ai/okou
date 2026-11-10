#if DEBUG || STAGING
  import Foundation

  /// A runtime-only QA credential, scoped to the API host instead of every request.
  enum StagingPreviewAccess {
    static func configure(
      apiURL: URL, bypass: String?, storage: HTTPCookieStorage = .shared
    ) {
      guard apiURL.scheme == "https", let host = apiURL.host,
        host == "staging-api.vm6.ai"
          || host.wholeMatch(of: #/pr-[0-9]+-api\.vm6\.ai/#) != nil,
        let bypass, !bypass.isEmpty,
        let cookie = HTTPCookie(properties: [
          .name: "x-vercel-protection-bypass", .value: bypass,
          .originURL: apiURL, .path: "/api/", .secure: "TRUE",
          .expires: Date().addingTimeInterval(3600),
        ])
      else { return }
      storage.setCookie(cookie)
    }
  }
#endif
