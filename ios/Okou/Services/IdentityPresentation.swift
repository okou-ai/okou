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
  private(set) var workspaces: [WorkspacePresentation] = []
  private(set) var preparedWorkspaceID: String?
  private var images: [String: IdentityImageRead] = [:]
  private var restoration: Task<Void, Never>?
  private var hasFreshWorkspaces = false
  private var closed = false
  private var preparationID = UUID()
  private var workspaceRevision = 0

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
    let preparation = UUID()
    preparationID = preparation
    if restoration == nil {
      restoration = Task { [weak self, cache] in
        let values = await cache.workspaces()
        guard let self, !closed, !hasFreshWorkspaces else { return }
        if !values.isEmpty { workspaces = values }
      }
    }
    await restoration?.value
    guard !closed, !Task.isCancelled, preparationID == preparation else { return }
    let workspace = workspace(workspaceID)
    let logo = read("workspace:" + workspaceID)
    if let workspace { logo.configure(workspace.hasImage ? workspace.imageURL : nil) }
    let profile = read("profile")
    profile.configure(hasProfileImage ? profileURL : nil)
    // Resolve only local bytes before presenting the sidebar. Network reads follow below.
    async let cachedLogo: Void = logo.restore()
    async let cachedProfile: Void = profile.restore()
    await cachedLogo
    await cachedProfile
    guard !closed, !Task.isCancelled, preparationID == preparation else { return }
    preparedWorkspaceID = workspaceID
    logo.refresh()
    profile.refresh()
  }

  func replaceWorkspaces(_ values: [WorkspacePresentation], activeID: String?) async {
    guard !closed else { return }
    workspaceRevision += 1
    let revision = workspaceRevision
    hasFreshWorkspaces = true
    workspaces = values
    let retained = Set(values.map { "workspace:" + $0.id }).union(["profile"])
    for entity in Array(images.keys) where !retained.contains(entity) {
      images.removeValue(forKey: entity)?.close()
      do { try await cache.removeImages(entity: entity) } catch { Self.log(error) }
      guard !closed, workspaceRevision == revision else { return }
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
      let retired = images.keys.first(where: {
        $0 != "profile" && $0 != "workspace:" + (preparedWorkspaceID ?? "")
      })
    {
      images.removeValue(forKey: retired)?.close()
    }
    let image = IdentityImageRead(entity: entity, cache: cache)
    images[entity] = image
    return image
  }

  fileprivate static func log(_ error: Error) {
    Logger(subsystem: "ai.okou.ios", category: "IdentityPresentation")
      .error(
        "event=identity.presentation.cache.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
      )
  }
}

/// One identity image. It owns its request; `image` retains the last successful rendering.
@MainActor @Observable
private final class IdentityImageRead {
  private(set) var image: UIImage?
  private let entity: String
  private let cache: IdentityPresentationCache
  private let decoder = IdentityImageDecoder()
  private var failed = false
  private var url: URL?
  /// The URL of the current request. A request is started again only for a new URL or a failure.
  private var requested: URL??
  private var request: Task<Void, Never>?
  private var closed = false
  private var configured = false

  init(entity: String, cache: IdentityPresentationCache) {
    self.entity = entity
    self.cache = cache
  }

  func configure(_ url: URL?) {
    guard !closed, !configured || self.url != url else { return }
    configured = true
    self.url = url
    request?.cancel()
    request = nil
    requested = nil
    if url == nil { image = nil }
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
    if let requested, requested == url, !failed { return }
    request?.cancel()
    failed = false
    requested = .some(url)
    let url = url
    request = Task.immediate { @MainActor [weak self, cache, entity, decoder] in
      guard let self else { return }
      do {
        try Task.checkCancellation()
        guard !closed, self.url == url else { return }
        guard let url else {
          try await cache.removeImages(entity: entity)
          return
        }
        let bytes = try await cache.image(entity: entity, url: url)
        try Task.checkCancellation()
        let decoded = await decoder.image(bytes)
        try Task.checkCancellation()
        guard !closed, self.url == url else { return }
        if let decoded {
          image = decoded
        } else {
          failed = true
          try await cache.removeImages(entity: entity)
        }
      } catch is CancellationError {
      } catch {
        if !closed, !Task.isCancelled { failed = true }
        IdentityPresentation.log(error)
      }
    }
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
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 192,
          kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary)
    else { return nil }
    return UIImage(cgImage: image)
  }
}
