import Foundation

public final class Preferences {
  public let url: URL
  private var values: [String: JSONValue]
  public init(directory: URL) throws {
    url = directory.appendingPathComponent("desktop-preferences.json")
    if FileManager.default.fileExists(atPath: url.path) {
      let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
      guard let object = value.object else {
        throw DesktopFailure("invalid_preferences", "Desktop preferences must be an object")
      }
      values = object
    } else {
      values = [:]
    }
  }
  public var installationId: String {
    get throws {
      if let stored = values["computerUseInstallationId"] {
        guard let existing = stored.string, UUID(uuidString: existing) != nil else {
          throw DesktopFailure(
            "invalid_preferences", "The stored Computer Use installation ID is invalid")
        }
        return existing
      }
      let id = UUID().uuidString.lowercased()
      try set("computerUseInstallationId", .string(id))
      return id
    }
  }
  public func bool(_ key: String) -> Bool { values[key]?.bool == true }
  public func string(_ key: String) -> String? { values[key]?.string }
  public func set(_ key: String, _ value: JSONValue) throws {
    try set([key: value])
  }
  public func set(_ entries: [String: JSONValue]) throws {
    var updated = values
    updated.merge(entries) { _, new in new }
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(JSONValue.object(updated)).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    values = updated
  }
}
