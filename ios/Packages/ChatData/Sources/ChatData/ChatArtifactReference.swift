import ChatDomain
import Foundation

/// Mirrors PWA artifact recognition. A recognized identity still needs authorization when resolved.
public enum ChatArtifactReference {
  public static func parse(_ value: String, webURL: URL, apiURL: URL) -> ChatArtifact? {
    guard !value.contains(where: \.isWhitespace), !value.hasPrefix("//"),
      let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil
    else { return nil }
    let path = url.path(percentEncoded: true)
    if sameOrigin(url, webURL), url.query == nil,
      let match = path.wholeMatch(
        of: #/\/artifacts\/([a-f0-9]{32}|[a-z0-9]{10})(\.[a-z0-9]{1,12})?/#)
    {
      let hash = String(match.1)
      if hash.count == 32 && hash != String(repeating: "0", count: 32)
        && hash != String(repeating: "f", count: 32)
      {
        let chars = Array(hash)
        let id = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32]
          .map { String(chars[$0]) }.joined(separator: "-")
        guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id,
          ["1", "2", "3", "4", "5", "6", "7", "8"].contains(String(chars[12])),
          ["8", "9", "a", "b"].contains(String(chars[16]))
        else { return nil }
      }
      let reference = hash + (match.2.map(String.init) ?? "")
      return ChatArtifact(
        source: .reference(reference, fragment: url.fragment ?? ""), filename: reference)
    }
    if sameOrigin(url, apiURL), path == "/api/web/download-file",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let id = components.queryItems?.first(where: { $0.name == "file_id" })?.value, !id.isEmpty
    {
      return ChatArtifact(
        source: .file(id),
        filename: components.queryItems?.first(where: { $0.name == "filename" })?.value ?? "File")
    }
    let legacy = path.wholeMatch(of: #/\/(?:f|artifacts)\/[^/]+\/[^/]+\/[^/]+/#) != nil
    let short = path.wholeMatch(of: #/\/artifacts\/[0-9a-z]{10}\.[^/]+/#) != nil
    let shortOrigin = ["https://a.okou.io:443", "https://files.sites.vm7.io:443"].contains(
      origin(url))
    let publication =
      path.wholeMatch(of: #/\/(?:[0-9a-z]{10}|[a-f0-9]{24})\.[a-z0-9]{1,12}/#) != nil
    let trusted =
      sameOrigin(url, webURL) || sameOrigin(url, apiURL)
      || ["cdn.vm0.io", "cdn.okou.io", "cdn.vm7.io", "app.okou.ai"].contains(url.host ?? "")
      || isPreviewPlatform(url.host ?? "")
    let explicitOrigin = value.contains("://")
    if (legacy && (!explicitOrigin || trusted)) || (short && trusted && explicitOrigin)
      || (shortOrigin && publication)
    {
      guard let published = legacy ? normalizedLegacyURL(url, webURL: webURL) : url else {
        return nil
      }
      return ChatArtifact(source: .published(published), filename: url.lastPathComponent)
    }
    if ChatOfficialArtifactPreviews.urls.contains(url.absoluteString) {
      return ChatArtifact(source: .published(url), filename: url.lastPathComponent)
    }
    if isHostedSite(url) {
      return ChatArtifact(
        source: .published(url), filename: url.host ?? "Web page", contentType: "text/html")
    }
    return nil
  }

  private static func normalizedLegacyURL(_ url: URL, webURL: URL) -> URL? {
    let segments = url.path(percentEncoded: true).split(separator: "/").map(String.init)
    let user = segments[1]
    let storageUser =
      user == "user" || user.hasPrefix("user_") || user.hasPrefix("user-") ? user : "user_" + user
    guard let host = webURL.host else { return nil }
    let production = host == "okou.ai" || host.hasSuffix(".okou.ai")
    var components = URLComponents()
    components.scheme = "https"
    components.host = production ? "cdn.vm0.io" : "cdn.vm7.io"
    components.percentEncodedPath =
      "/artifacts/\(segments[0] == "f" ? storageUser : user)/\(segments[2])/\(segments[3])"
    components.fragment = url.fragment
    return components.url
  }

  private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool { origin(lhs) == origin(rhs) }

  private static func origin(_ url: URL) -> String {
    let port = url.port ?? (url.scheme == "https" ? 443 : 80)
    return "\(url.scheme ?? "")://\(url.host?.lowercased() ?? ""):\(port)"
  }

  private static func isPreviewPlatform(_ host: String) -> Bool {
    (host.hasSuffix(".vm6.ai") || host.hasSuffix(".vm7.ai"))
      && host.range(of: #"(^|-)(platform|app|www|api)\."#, options: .regularExpression) != nil
  }

  private static func isHostedSite(_ url: URL) -> Bool {
    guard let host = url.host, host != "files.sites.vm7.io" else { return false }
    return ["okou.app", "sites.vm0.io", "sites.vm7.io"].contains { domain in
      guard host.hasSuffix("." + domain) else { return false }
      let slug = String(host.dropLast(domain.count + 1))
      return slug.wholeMatch(of: #/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/#) != nil
    }
  }
}
