import Foundation

public enum ComposerReturnKeyPreference: String, Codable, CaseIterable, Hashable, Sendable {
  case newline, send
}

/// Device-owned UI preferences survive account/workspace changes and cache eviction.
/// The app's main-actor preference owner serializes these small atomic file operations.
public struct ComposerPreferencesStorage: Sendable {
  private let fileURL: URL

  public init(directory: URL? = nil) {
    let root =
      directory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    fileURL = root.appending(path: "ComposerPreferences", directoryHint: .isDirectory)
      .appending(path: "return-key.json")
  }

  public func returnKey() throws -> ComposerReturnKeyPreference {
    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return .newline
    }
    return try JSONDecoder().decode(ComposerReturnKeyPreference.self, from: data)
  }

  public func setReturnKey(_ preference: ComposerReturnKeyPreference) throws {
    let data = try JSONEncoder().encode(preference)
    try FileManager.default.createDirectory(
      at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: fileURL, options: .atomic)
  }
}
