import ChatData
import Foundation
import XCTest

@MainActor
final class CacheTestDirectory {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  private var caches: [ChatCache] = []

  init(owner: XCTestCase) {
    owner.addTeardownBlock { @MainActor [self] in
      for cache in caches { await cache.close() }
      caches = []
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }

  func cache(scope: ChatCacheScope, migratingFrom directory: URL? = nil) -> ChatCache {
    let cache = ChatCache(scope: scope, directory: url, migratingFrom: directory)
    caches.append(cache)
    return cache
  }
}
