import CryptoKit
import Foundation

/// The app's disposable layout data is separate from canonical chat history.
actor ConversationHeightDiskCache {
  static let shared = ConversationHeightDiskCache(
    file: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent("ConversationHeights-v1.json"))

  struct Layout: Encodable, Hashable, Sendable {
    let width: Double
    let scale: Double
    let category: String
    let direction: Int
    let legibility: Int
    let style: Int
    let locale: String
    let renderer: String
  }

  struct Key: Encodable, Hashable, Sendable {
    let namespace: [String]
    let id: String
    let text: String
    let role: String
    let showsAvatar: Bool
    let spacing: Double
    let workHistory: Bool
    let layout: Layout
  }

  private struct Entry: Codable {
    let digest: String
    let height: Double
  }

  private let file: URL?
  private let limit: Int

  init(file: URL?, limit: Int = 4_096) {
    self.file = file
    self.limit = limit
  }

  func heights(for keys: [String: Key]) -> [String: Double] {
    guard !keys.isEmpty else { return [:] }
    let entries = read()
    let heights = Dictionary(
      entries.map { ($0.digest, $0.height) }, uniquingKeysWith: { _, last in last })
    return keys.reduce(into: [:]) { result, pair in
      if let digest = digest(pair.value), let height = heights[digest], height.isFinite, height > 0
      {
        result[pair.key] = height
      }
    }
  }

  func store(_ heights: [Key: Double]) {
    guard let file, !heights.isEmpty else { return }
    let updates = heights.compactMap { key, height -> Entry? in
      guard height.isFinite, height > 0, let digest = digest(key) else { return nil }
      return Entry(digest: digest, height: height)
    }
    let replaced = Set(updates.map(\.digest))
    let entries = read().filter { !replaced.contains($0.digest) } + updates
    guard let data = try? JSONEncoder().encode(Array(entries.suffix(limit))) else { return }
    try? data.write(to: file, options: .atomic)
  }

  private func read() -> [Entry] {
    guard let file, let data = try? Data(contentsOf: file),
      let entries = try? JSONDecoder().decode([Entry].self, from: data)
    else { return [] }
    return entries
  }

  private func digest(_ key: Key) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    guard let data = try? encoder.encode(key) else { return nil }
    return Data(SHA256.hash(data: data)).base64EncodedString()
  }
}
