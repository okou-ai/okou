import Foundation

/// Runtime-only credential for an operator-authorized PR preview.
public struct DesktopPreviewCredential: Decodable, Sendable {
  static let header = "x-okou-desktop-preview"
  let origin: String
  let expiresAt: TimeInterval
  let token: String

  public static func load(
    for apiURL: URL, bundleIdentifier: String?, path: String?
  ) -> Self? {
    guard bundleIdentifier == "ai.okou.desktop.dev", let path,
      let attributes = try? FileManager.default.attributesOfItem(atPath: path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let permissions = attributes[.posixPermissions] as? NSNumber,
      permissions.intValue & 0o077 == 0,
      let size = attributes[.size] as? NSNumber, size.intValue <= 4096,
      let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
      let value = try? JSONDecoder().decode(Self.self, from: data),
      value.value(for: apiURL) != nil
    else { return nil }
    return value
  }

  func value(for url: URL) -> String? {
    guard url.scheme == "https", url.port == nil, url.user == nil, url.password == nil,
      let host = url.host,
      host.range(of: #"^pr-[1-9][0-9]*-api\.vm6\.ai$"#, options: .regularExpression) != nil,
      origin == "https://" + host,
      Date().timeIntervalSince1970 < expiresAt,
      !token.isEmpty, token.utf8.count <= 1024,
      token.utf8.allSatisfy({ (33...126).contains($0) })
    else { return nil }
    return token
  }
}
