import CCState
import ChatData
import Foundation
import ImageIO
import OSLog
import Observation
import UIKit

/// One account owns its retained display snapshot and shared image reads.
@MainActor @Observable
final class IdentityPresentation {
  let userID: String
  let cache: IdentityPresentationCache
  let store = CCState.Store()
  private(set) var workspaces: [WorkspacePresentation] = []
  private(set) var preparedWorkspaceID: String?
  private var images: [String: IdentityImageRead] = [:]
  private var restoration: Task<Void, Never>?
  private var hasFreshWorkspaces = false
  private var closed = false

  init(userID: String, cache: IdentityPresentationCache, workspaces: [WorkspacePresentation] = []) {
    self.userID = userID
    self.cache = cache
    self.workspaces = workspaces
  }

  func workspace(_ id: String) -> WorkspacePresentation? {
    workspaces.first { $0.id == id }
  }

  func image(_ entity: String) -> UIImage? { images[entity]?.image }

  func restore(workspaceID: String, profileURL: URL?, hasProfileImage: Bool) async {
    if restoration == nil {
      restoration = Task { [weak self, cache] in
        let values = await cache.workspaces()
        guard let self, !closed, !hasFreshWorkspaces else { return }
        if !values.isEmpty { workspaces = values }
      }
    }
    await restoration?.value
    guard !closed, !Task.isCancelled else { return }
    let workspace = workspace(workspaceID)
    let logo = read("workspace:" + workspaceID)
    if let workspace { logo.configure(workspace.hasImage ? workspace.imageURL : nil) }
    let profile = read("profile")
    profile.configure(hasProfileImage ? profileURL : nil)
    // Resolve only local bytes before presenting the sidebar. Network reads follow below.
    await logo.restore()
    await profile.restore()
    guard !closed, !Task.isCancelled else { return }
    preparedWorkspaceID = workspaceID
    logo.refresh()
    profile.refresh()
  }

  func replaceWorkspaces(_ values: [WorkspacePresentation], activeID: String?) async {
    guard !closed else { return }
    hasFreshWorkspaces = true
    workspaces = values
    let retained = Set(values.map { "workspace:" + $0.id }).union(["profile"])
    for entity in Array(images.keys) where !retained.contains(entity) {
      images.removeValue(forKey: entity)?.close()
      do { try await cache.removeImages(entity: entity) } catch { Self.log(error) }
    }
    for workspace in values.prefix(100) {
      let image = read("workspace:" + workspace.id)
      image.configure(workspace.hasImage ? workspace.imageURL : nil)
      image.refresh()
    }
    do { try await cache.saveWorkspaces(values, activeID: activeID) } catch { Self.log(error) }
  }

  func close(removeFiles: Bool) async {
    guard !closed else { return }
    closed = true
    restoration?.cancel()
    for image in images.values { image.close() }
    images = [:]
    workspaces = []
    preparedWorkspaceID = nil
    do { try await cache.close(removeFiles: removeFiles) } catch { Self.log(error) }
  }

  private func read(_ entity: String) -> IdentityImageRead {
    if let image = images[entity] { return image }
    // Current account photo plus at most 100 workspace marks; the active mark is protected.
    if images.count >= 101,
      let retired = images.keys.first(where: { $0 != "profile" && $0 != "workspace:" + (preparedWorkspaceID ?? "") })
    {
      images.removeValue(forKey: retired)?.close()
    }
    let image = IdentityImageRead(entity: entity, cache: cache, store: store)
    images[entity] = image
    return image
  }

  fileprivate static func log(_ error: Error) {
    Logger(subsystem: "ai.okou.ios", category: "IdentityPresentation")
      .error("Cannot update identity display cache: \(error.localizedDescription, privacy: .public)")
  }
}

/// The graph owns request sharing/cancellation; image retains the last successful rendering.
@MainActor @Observable
private final class IdentityImageRead {
  private(set) var image: UIImage?
  private let entity: String
  private let cache: IdentityPresentationCache
  private let decoder = IdentityImageDecoder()
  private let store: CCState.Store
  private let source = CCState.State<URL?>(nil)
  private let revision = CCState.State(0)
  private var failed = false
  private var url: URL?
  private var request: Task<Void, Never>?
  private var closed = false
  private var configured = false

  init(entity: String, cache: IdentityPresentationCache, store: CCState.Store) {
    self.entity = entity
    self.cache = cache
    self.store = store
  }

  @ObservationIgnored private lazy var value = Computed<Task<Void, Never>> { [weak self] get, options in
    guard let self, !closed else { return Task {} }
    let url = try get(source)
    _ = try get(revision)
    failed = false
    let signal = options.signal
    let task = Task.immediate { @MainActor [weak self, cache, entity] in
      guard let self else { return }
      do {
        guard let url else {
          try await cache.removeImages(entity: entity)
          return
        }
        let bytes = try await cache.image(entity: entity, url: url)
        try Task.checkCancellation()
        try signal.checkCancellation()
        let decoded = await decoder.image(bytes)
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard !closed, self.url == url else { return }
        if let decoded {
          image = decoded
        } else {
          try await cache.removeImages(entity: entity)
        }
      } catch is CancellationError {
      } catch {
        if !closed, !Task.isCancelled { failed = true }
        IdentityPresentation.log(error)
      }
    }
    request = task
    signal.onCancel { task.cancel() }
    return task
  }

  func configure(_ url: URL?) {
    guard !closed, !configured || self.url != url else { return }
    configured = true
    self.url = url
    request?.cancel()
    if url == nil { image = nil }
    do { try store.set(source, url) } catch { IdentityPresentation.log(error) }
  }

  func restore() async {
    guard !closed, let url, image == nil else { return }
    let bytes = await cache.cachedImage(entity: entity, url: url)
    guard let bytes else { return }
    let cached = await decoder.image(bytes)
    guard !closed, self.url == url, !Task.isCancelled else { return }
    if image == nil { image = cached }
  }

  func refresh() {
    guard !closed, configured else { return }
    do {
      if failed { try store.set(revision, update: { $0 + 1 }) }
      request = try store.get(value)
    } catch { IdentityPresentation.log(error) }
  }

  func close() {
    closed = true
    request?.cancel()
    image = nil
  }

  isolated deinit { request?.cancel() }
}

/// Decode small identity marks off the main actor; retain no source bytes or account state.
private actor IdentityImageDecoder {
  func image(_ data: Data) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 192,
        kCGImageSourceShouldCacheImmediately: true,
      ] as CFDictionary)
    else { return nil }
    return UIImage(cgImage: image)
  }
}
