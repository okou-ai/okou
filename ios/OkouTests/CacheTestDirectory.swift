import ChatData
import Foundation
import XCTest

@MainActor
final class CacheTestDirectory {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  private var references: [CacheReference] = []

  init(owner: XCTestCase, file: StaticString = #filePath, line: UInt = #line) {
    owner.addTeardownBlock { @MainActor [self] in
      for reference in references { try await reference.release(file: file, line: line) }
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }

  func cache(scope: ChatCacheScope) -> ChatCache {
    let cache = ChatCache(scope: scope, directory: url)
    references.append(CacheReference(cache))
    return cache
  }
}

@MainActor
private final class CacheReference {
  private var cache: ChatCache?
  init(_ cache: ChatCache) { self.cache = cache }

  func release(file: StaticString, line: UInt) async throws {
    // Keep the final reference until all clients and their work have released it.
    // Dropping it here closes SQLite synchronously before its files are removed.
    let deadline = ContinuousClock.now + .seconds(3)
    while !isKnownUniquelyReferenced(&cache), ContinuousClock.now < deadline {
      await Task.yield()
    }
    _ = try XCTUnwrap(
      isKnownUniquelyReferenced(&cache) ? true : nil,
      "The cache is still retained by an unsettled test owner", file: file, line: line)
    cache = nil
  }
}
