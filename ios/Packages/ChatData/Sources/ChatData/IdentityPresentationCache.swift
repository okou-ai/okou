import CryptoKit
import Foundation

/// Display metadata is never evidence of current workspace membership.
public struct WorkspacePresentation: Codable, Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let imageURL: URL?
  public let hasImage: Bool

  public init(id: String, name: String, imageURL: URL? = nil, hasImage: Bool = false) {
    self.id = id
    self.name = name
    self.imageURL = imageURL
    self.hasImage = hasImage
  }
}

/// Disposable, account-scoped display data. Image bytes have a hard 16 MiB disk budget.
public actor IdentityPresentationCache {
  private let directory: URL
  private let session: URLSession
  private let maximumBytes: Int
  private var closed = false

  public init(
    environment: String, userID: String, directory: URL? = nil,
    session: URLSession = .shared, maximumBytes: Int = 16 * 1024 * 1024
  ) {
    let root = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    self.directory = root.appending(path: "IdentityPresentation-v1")
      .appending(path: Self.digest(environment + "\u{0}" + userID), directoryHint: .isDirectory)
    self.session = session
    self.maximumBytes = maximumBytes
  }

  public func workspaces() -> [WorkspacePresentation] {
    guard !closed, let data = try? Data(contentsOf: directory.appending(path: "workspaces.json")),
      let values = try? JSONDecoder().decode([WorkspacePresentation].self, from: data)
    else { return [] }
    return values
  }

  public func saveWorkspaces(_ values: [WorkspacePresentation], activeID: String?) throws {
    guard !closed else { return }
    let active = values.filter { $0.id == activeID }
    let others = values.filter { $0.id != activeID }
    let data = try JSONEncoder().encode(Array((active + others).prefix(100)))
    try createDirectory()
    try data.write(to: directory.appending(path: "workspaces.json"), options: .atomic)
  }

  public func cachedImage(entity: String, url: URL) -> Data? {
    guard !closed else { return nil }
    let file = imageFile(entity: entity, url: url)
    guard let data = try? Data(contentsOf: file) else { return nil }
    // Access time is separate from the validation date used by image().
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
    return data
  }

  public func image(entity: String, url: URL) async throws -> Data {
    guard !closed else { throw CancellationError() }
    let file = imageFile(entity: entity, url: url)
    let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
    let validated = attributes?[.creationDate] as? Date
    if let validated, Date().timeIntervalSince(validated) < 86_400,
      let data = cachedImage(entity: entity, url: url)
    {
      return data
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadRevalidatingCacheData
    let (data, response) = try await session.data(for: request)
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
      !data.isEmpty, data.count <= min(maximumBytes, 4 * 1024 * 1024)
    else { throw URLError(.badServerResponse) }
    try createDirectory()
    try data.write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.creationDate: Date()], ofItemAtPath: file.path)
    try pruneImages()
    return data
  }

  public func removeImages(entity: String) throws {
    try Task.checkCancellation()
    guard !closed else { return }
    let prefix = Self.digest(entity) + "-"
    for file in try files() where file.lastPathComponent.hasPrefix(prefix) {
      try FileManager.default.removeItem(at: file)
    }
  }

  public func close(removeFiles: Bool = false) throws {
    closed = true
    if removeFiles, FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  private func imageFile(entity: String, url: URL) -> URL {
    directory.appending(
      path: Self.digest(entity) + "-" + Self.digest(url.absoluteString) + ".image")
  }

  private func createDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  private func files() throws -> [URL] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
  }

  private func pruneImages() throws {
    let entries = try files().filter { $0.pathExtension == "image" }.map { file in
      let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
      return (file, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
    }.sorted { $0.2 < $1.2 }
    var size = entries.reduce(0) { $0 + $1.1 }
    var count = entries.count
    for (file, bytes, _) in entries {
      guard size > maximumBytes || count > 100 else { break }
      try FileManager.default.removeItem(at: file)
      size -= bytes
      count -= 1
    }
  }

  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
