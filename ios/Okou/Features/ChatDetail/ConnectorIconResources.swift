import CCState
import Foundation
import UIKit

/// Public, content-addressed catalog artwork is shared across the app, not an account.
@MainActor
final class ConnectorIconResources {
  static let shared = ConnectorIconResources()

  let store = CCState.Store()
  fileprivate let lifetime = CCState.State(true)
  private let loader: ConnectorIconLoader
  private let cache: NSCache<NSURL, ConnectorIconRead> = {
    let cache = NSCache<NSURL, ConnectorIconRead>()
    cache.totalCostLimit = 8 * 1024 * 1024
    cache.countLimit = 128
    return cache
  }()
  private final class WeakRead {
    weak var value: ConnectorIconRead?
    init(_ value: ConnectorIconRead) { self.value = value }
  }
  private var live: [URL: WeakRead] = [:]
  private var pending: [URL: ConnectorIconRead] = [:]
  private var closed = false

  init(loader: ConnectorIconLoader = ConnectorIconLoader()) { self.loader = loader }

  func icon(_ url: URL) -> ConnectorIconRead {
    if let read = pending[url] ?? cache.object(forKey: url as NSURL) ?? live[url]?.value {
      return read
    }
    live = live.filter { $0.value.value != nil }
    let read = ConnectorIconRead(url: url, owner: self)
    if !closed {
      live[url] = WeakRead(read)
      cache.setObject(read, forKey: url as NSURL)
    }
    return read
  }

  func retryIfNeeded(_ read: ConnectorIconRead) {
    guard !closed, read.failed else { return }
    // The command only increments a local revision; remote failures remain in the read Task.
    do { try read.retry(in: store) } catch {
      preconditionFailure("Cannot invalidate local Connector icon inputs: \(error)")
    }
  }

  fileprivate func started(_ read: ConnectorIconRead) { pending[read.url] = read }

  fileprivate func finished(_ read: ConnectorIconRead) {
    if pending[read.url] === read { pending[read.url] = nil }
  }

  fileprivate func load(_ read: ConnectorIconRead) async throws -> UIImage {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let image = try await loader.load(read.url)
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let cost = Int(image.size.width * image.scale) * Int(image.size.height * image.scale) * 4
    // The cache retains read owners, so eviction can release the graph's cached Task/result.
    // These are advisory NSCache policies; mounted and pending reads may outlive eviction.
    cache.setObject(read, forKey: read.url as NSURL, cost: cost)
    return image
  }

  func close() throws {
    guard !closed else { return }
    closed = true
    for read in pending.values { read.cancel() }
    pending = [:]
    cache.removeAllObjects()
    live = [:]
    loader.close()
    try store.set(lifetime, false)
  }
}

@MainActor
final class ConnectorIconRead {
  fileprivate let url: URL
  fileprivate var failed = false
  private weak var owner: ConnectorIconResources?
  private let revision = CCState.State(0)
  private let reload: Command<Void, Void>
  private var request: Task<UIImage, Error>?

  fileprivate init(url: URL, owner: ConnectorIconResources) {
    self.url = url
    self.owner = owner
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<UIImage, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, try get(owner.lifetime) else { throw CancellationError() }
      _ = try get(revision)
      failed = false
      let signal = options.signal
      owner.started(self)
      let task = Task<UIImage, Error> { @MainActor [self, owner] in
        defer { owner.finished(self) }
        do {
          let image = try await owner.load(self)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return image
        } catch {
          if !Task.isCancelled { failed = true }
          throw error
        }
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  fileprivate func retry(in store: CCState.Store) throws {
    cancel()
    try store.set(reload)
  }

  fileprivate func cancel() { request?.cancel() }
  isolated deinit { request?.cancel() }
}
