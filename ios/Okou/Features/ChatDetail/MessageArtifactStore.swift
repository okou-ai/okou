import ChatData
import ChatDomain
import Foundation
import Observation

/// One detail owns previews, catalog metadata and cancellation. No signed URL survives this scope.
@MainActor @Observable
final class MessageArtifactStore {
  struct Preview: Identifiable {
    let id = UUID()
    var artifact: ChatArtifact
    var images: [ChatArtifact]
    var file: ChatAttachmentFile?
    var contentURL: URL?
    var htmlExpiresAt: Date?
    var text: ArtifactTextContent?
    var error: String?
    var canRetry = true
    var renewedHTMLSignature = false
    var isDownloading = false
    var downloadError: String?
  }

  struct Share: Identifiable {
    let id = UUID()
    let file: ChatAttachmentFile
  }

  struct Card: Sendable {
    let artifact: ChatArtifact
    let thumbnail: Data?
    /// A website's own title, read while drawing its cover.
    var title: String? = nil
  }

  private(set) var preview: Preview?
  private(set) var sharing: Share?
  private(set) var catalogWarning: String?
  private let service: ChatArtifacts
  private let threadID: String
  private let markdown: MessageMarkdownCache
  let webURL: URL
  var apiURL: URL { service.apiURL }
  private let didFail: @MainActor (Error) -> Void
  private var catalog: [ChatArtifact]?
  /// Covers drawn this visit, so a row scrolled back into view does not fetch its file again.
  private var cards: [ChatArtifact.Source: Card] = [:]
  private var catalogTask: Task<[ChatArtifact], Error>?
  private var operations: [UUID: @MainActor () -> Void] = [:]
  private var previewTask: Task<Void, Never>?
  private var saveTask: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(
    service: ChatArtifacts, threadID: String, webURL: URL, markdown: MessageMarkdownCache,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.threadID = threadID
    self.webURL = webURL
    self.markdown = markdown
    self.didFail = didFail
  }

  func resource(_ value: String) -> ChatArtifact? {
    ChatArtifactReference.parse(value, webURL: webURL, apiURL: service.apiURL)
  }

  func card(_ resource: ChatArtifact, thumbnail: Bool) async throws -> Card {
    if thumbnail, let card = cards[resource.id] { return card }
    try await loadCatalog()
    let artifact = metadata(resource)
    let service = service
    let webURL = webURL
    let card = try await perform {
      if thumbnail {
        let (resolved, file) = try await service.thumbnail(artifact, webURL: webURL)
        var data: Data?
        if let file {
          data = await AttachmentFileImporter.shared.thumbnail(file.url, maximumPixelSize: 800)
        } else {
          data = nil
        }
        if data == nil, resolved.kind == .video {
          let playback = try await service.resolve(resolved)
          data = try await ArtifactVideoPoster.shared.thumbnail(playback.contentURL)
        }
        if data == nil, resolved.kind == .html {
          // No server preview: draw the page's first screen, as the web's card shows the live
          // page scaled into its frame.
          let page = try await service.resolve(resolved)
          let snapshot = await SitePreviewSnapshotter.shared.snapshot(page.contentURL)
          return Card(artifact: resolved, thumbnail: snapshot?.image, title: snapshot?.title)
        }
        if data == nil, resolved.hasCover {
          // No server preview: draw the first page or slide from the file itself, as Files
          // does. A cover is a nicety, so a file too large or unreadable keeps the glyph.
          if let (_, document) = try? await service.download(
            resolved, maximumSize: Self.coverDownloadLimit)
          {
            data = await AttachmentFileImporter.shared.documentCover(document.url)
          }
        }
        return Card(artifact: resolved, thumbnail: data)
      }
      let resolved = try await service.resolve(artifact)
      return Card(artifact: resolved.artifact, thumbnail: nil)
    }
    if thumbnail, card.thumbnail != nil { cards[resource.id] = card }
    return card
  }

  /// The largest file the transcript downloads only to draw its cover.
  private static let coverDownloadLimit = 25 * 1024 * 1024

  func open(
    _ resource: ChatArtifact, images: [ChatArtifact] = [], imageSources: [String] = [],
    renewedHTMLSignature: Bool = false
  ) {
    guard !closed else { return }
    dismiss()
    var item = Preview(artifact: metadata(resource), images: images)
    item.renewedHTMLSignature = renewedHTMLSignature
    let previewID = item.id
    preview = item
    previewTask = Task { [weak self] in
      guard let self else { return }
      do {
        try await loadCatalog()
        let artifact = metadata(resource)
        let service = service
        let resolved = try await perform { try await service.resolve(artifact) }
        guard !Task.isCancelled, preview?.id == previewID else { return }
        preview?.artifact = resolved.artifact
        if resolved.artifact.kind == .image, !imageSources.isEmpty {
          var group: [ChatArtifact] = []
          var seen = Set<ChatArtifact.Source>()
          for source in imageSources {
            let content = await markdown.content(for: source)
            guard !Task.isCancelled, preview?.id == previewID else { return }
            for image in MessageArtifactBody.resources(content, resolve: self.resource).map(
              metadata)
            where image.kind == .image && seen.insert(image.id).inserted { group.append(image) }
          }
          preview?.images = group
        }
        if resolved.artifact.kind == .html {
          preview?.contentURL = resolved.contentURL
          preview?.htmlExpiresAt = resolved.expiresAt
        } else {
          let kind = resolved.artifact.kind
          let isText = [.markdown, .text, .json, .csv].contains(kind)
          let (downloaded, file) = try await perform {
            try await service.download(
              resolved.artifact, maximumSize: isText ? 2 * 1024 * 1024 : ChatAttachment.maximumSize)
          }
          let text = isText ? try await ArtifactTextReader.shared.read(file, kind: kind) : nil
          guard !Task.isCancelled, preview?.id == previewID else { return }
          preview?.artifact = downloaded
          preview?.file = file
          preview?.text = text
        }
      } catch {
        guard !Task.isCancelled, preview?.id == previewID else { return }
        preview?.error = Self.message(for: error)
        preview?.canRetry = ChatRequestFailure.canRetry(error)
      }
    }
  }

  func renewHTMLSignature(status: Int?) -> Bool {
    guard let item = preview, !item.renewedHTMLSignature else { return false }
    let expired = item.htmlExpiresAt.map { $0 <= Date() } ?? false
    guard [401, 403].contains(status ?? 0) || (status == 404 && expired) else { return false }
    switch item.artifact.source {
    case .reference, .file, .hostedSite:
      open(item.artifact, images: item.images, renewedHTMLSignature: true)
      return true
    case .published: return false
    }
  }

  func navigateImage(_ direction: Int) {
    guard let preview else { return }
    let images = preview.images.map(metadata).filter { $0.kind == .image }
    guard let index = images.firstIndex(where: { $0.id == preview.artifact.id }),
      images.indices.contains(index + direction)
    else { return }
    open(images[index + direction], images: images)
  }

  func canNavigateImage(_ direction: Int) -> Bool {
    guard let preview else { return false }
    let images = preview.images.map(metadata).filter { $0.kind == .image }
    guard let index = images.firstIndex(where: { $0.id == preview.artifact.id }) else {
      return false
    }
    return images.indices.contains(index + direction)
  }

  func share() {
    guard !closed, let file = preview?.file else { return }
    sharing = Share(file: file)
  }

  func dismissSharing() { sharing = nil }

  func downloadForSharing() {
    guard !closed, let item = preview, !item.isDownloading, item.file == nil else { return }
    preview?.isDownloading = true
    preview?.downloadError = nil
    let service = service
    saveTask = Task { [weak self] in
      guard let self else { return }
      defer { if preview?.id == item.id { preview?.isDownloading = false } }
      do {
        let (_, file) = try await perform { try await service.download(item.artifact) }
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.file = file
      } catch {
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.downloadError = Self.message(for: error)
      }
    }
  }

  func refreshDetails() async {
    guard !closed, let id = preview?.id else { return }
    catalog = nil
    do {
      try await loadCatalog()
      guard !closed, !Task.isCancelled, preview?.id == id, let artifact = preview?.artifact else {
        return
      }
      preview?.artifact = metadata(artifact)
    } catch {
      guard !closed, !Task.isCancelled, preview?.id == id else { return }
      preview?.error = Self.message(for: error)
      preview?.canRetry = ChatRequestFailure.canRetry(error)
    }
  }

  func retry() {
    guard let preview else { return }
    catalog = nil
    open(preview.artifact, images: preview.images)
  }

  func dismiss() {
    previewTask?.cancel()
    saveTask?.cancel()
    previewTask = nil
    saveTask = nil
    preview = nil
    sharing = nil
  }

  func deactivate() {
    generation = UUID()
    dismiss()
    catalogTask?.cancel()
    catalogTask = nil
    catalog = nil
    catalogWarning = nil
    for cancel in operations.values { cancel() }
    operations.removeAll()
  }

  func close() {
    closed = true
    deactivate()
  }

  private func metadata(_ artifact: ChatArtifact) -> ChatArtifact {
    guard let value = catalog?.first(where: { $0.id == artifact.id }) else { return artifact }
    return ChatArtifact(
      source: artifact.source, filename: value.filename, contentType: value.contentType,
      size: value.size, artifactKind: value.artifactKind)
  }

  private func loadCatalog() async throws {
    guard !closed else { throw CancellationError() }
    if catalog != nil { return }
    let scope = generation
    let task: Task<[ChatArtifact], Error>
    if let existing = catalogTask {
      task = existing
    } else {
      let service = service
      let threadID = threadID
      let webURL = webURL
      task = Task { try await service.list(threadID: threadID, webURL: webURL) }
      catalogTask = task
    }
    do {
      let values = try await task.value
      try Task.checkCancellation()
      guard !closed, generation == scope else { throw CancellationError() }
      catalog = values
      catalogWarning = nil
      catalogTask = nil
    } catch {
      guard !closed, generation == scope, !Task.isCancelled else { throw CancellationError() }
      catalogTask = nil
      if let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status) {
        didFail(error)
        throw error
      }
      // Catalog labels/sizes are supplementary; the resource authority still decides access.
      catalog = []
      catalogWarning = "Some file details could not be loaded."
    }
  }

  private func perform<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T)
    async throws -> T
  {
    guard !closed else { throw CancellationError() }
    let scope = generation
    let id = UUID()
    let task = Task { try await operation() }
    operations[id] = { task.cancel() }
    defer { operations[id] = nil }
    do {
      let result = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
      try Task.checkCancellation()
      guard !closed, generation == scope else { throw CancellationError() }
      return result
    } catch {
      if !closed, generation == scope, !Task.isCancelled,
        let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status)
      {
        didFail(error)
      }
      throw error
    }
  }

  /// A result that cannot be shown however often the card retries — deleted, or not this
  /// person's to see — in the few words a card's detail line holds. Nil for anything else.
  static func cardStatus(for error: Error) -> String? {
    var status = (error as? APIClientError)?.statusCode
    if let transport = error as? APIClientError, case .downloadFailed(let code) = transport {
      status = code
    }
    switch status {
    case 404, 410: return String(localized: "No longer available")
    case 403: return String(localized: "No access")
    default: return nil
    }
  }

  static func message(for error: Error) -> String {
    if let transport = error as? APIClientError, case .downloadFailed(let status) = transport {
      switch status {
      case 403: return "Access to this result was denied. Retry to refresh its download address."
      case 404, 410: return "This result was deleted or is no longer available."
      default: break
      }
    }
    switch (error as? APIClientError)?.statusCode {
    case 403: return "You do not have permission to view this result."
    case 404, 410: return "This result was deleted or is no longer available."
    default: break
    }
    if (error as? URLError)?.code == .dataLengthExceedsMaximum {
      return "This result is too large to read in the app. Download it to share or save to Files."
    }
    return ChatRequestFailure.message(for: error)
  }
}
