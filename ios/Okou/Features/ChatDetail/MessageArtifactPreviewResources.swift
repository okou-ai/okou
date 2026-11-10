import CCState
import ChatData
import ChatDomain
import Foundation

/// A single preview attempt owns the original reads, independently of its SwiftUI waiters.
@MainActor
final class MessageArtifactPreviewResources: Identifiable {
  struct Content: Sendable {
    let presentationID: UUID
    let artifact: ChatArtifact
    let images: [ChatArtifact]
    var file: ChatAttachmentFile? = nil
    var text: ArtifactTextContent? = nil
    var contentURL: URL? = nil
    var htmlExpiresAt: Date? = nil
  }

  let id = UUID()
  let store: CCState.Store
  let artifact: ChatArtifact
  let images: [ChatArtifact]
  let thumbnail: Data?
  let loadsMetadata: Bool
  let renewedHTMLSignature: Bool
  let imageSources: [String]
  private let service: ChatArtifacts
  private let reads: MessageArtifactResources
  private let markdown: MessageMarkdownCache
  private let webURL: URL
  private let didFail: @MainActor (Error) -> Void
  private let lifetime = CCState.State(true)
  private let downloadRevision = CCState.State(0)
  private let requestDownload: Command<Void, Void>
  private var previewTask: Task<Content, Error>?
  private var downloadTask: Task<ChatAttachmentFile?, Error>?
  private var closed = false

  init(
    artifact: ChatArtifact, images: [ChatArtifact], imageSources: [String], thumbnail: Data?,
    renewedHTMLSignature: Bool, service: ChatArtifacts, reads: MessageArtifactResources,
    markdown: MessageMarkdownCache, webURL: URL, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.artifact = artifact
    self.images = images
    self.imageSources = imageSources
    self.thumbnail = thumbnail
    self.renewedHTMLSignature = renewedHTMLSignature
    self.service = service
    self.reads = reads
    store = reads.store
    self.markdown = markdown
    self.webURL = webURL
    self.didFail = didFail
    loadsMetadata =
      service.uploadedFile(artifact) == nil || artifact.kind != .image
      || !imageSources.isEmpty
    let downloadRevision = downloadRevision
    let lifetime = lifetime
    requestDownload = Command { context in
      guard try context.get(lifetime) else { throw CancellationError() }
      try context.set(downloadRevision, update: { $0 + 1 })
    }
  }

  lazy var catalog = Computed<Task<[ChatArtifact], Error>> { [weak self] get in
    guard let self, !closed, try get(lifetime) else { throw CancellationError() }
    if loadsMetadata { return try get(reads.catalog) }
    return Task { [] }
  }
  lazy var content = makeContent()
  lazy var download = makeDownload()

  private func makeContent() -> Computed<Task<Content, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let signal = options.signal
      let task = Task.immediate { @MainActor [self] in
        try Task.checkCancellation()
        let value = try await loadContent()
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard !closed else { throw CancellationError() }
        return value
      }
      previewTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Full-file sharing never depends on the preview Task or its text size/decoding outcome.
  private func makeDownload() -> Computed<Task<ChatAttachmentFile?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let requested = try get(downloadRevision) > 0
      let signal = options.signal
      let task = Task<ChatAttachmentFile?, Error> { @MainActor [self] in
        do {
          try Task.checkCancellation()
          guard requested else { return nil }
          let (_, file) = try await service.download(artifact)
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard !closed else { throw CancellationError() }
          return file
        } catch {
          if !closed, !Task.isCancelled, !signal.isCancelled { reportAccessFailure(error) }
          throw error
        }
      }
      downloadTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func loadContent() async throws -> Content {
    if !loadsMetadata, let file = service.uploadedFile(artifact) {
      return Content(presentationID: id, artifact: artifact, images: images, file: file)
    }
    try await reads.prepareMetadata()
    try Task.checkCancellation()
    do {
      let resolved = try await service.resolve(reads.metadata(artifact))
      try Task.checkCancellation()
      var group = images
      if resolved.artifact.kind == .image, !imageSources.isEmpty {
        group = []
        var seen = Set<ChatArtifact.Source>()
        for source in imageSources {
          let content = await markdown.content(for: source)
          try Task.checkCancellation()
          for image in MessageArtifactBody.resources(
            content,
            resolve: {
              ChatArtifactReference.parse($0, webURL: webURL, apiURL: service.apiURL)
            }
          ).map(reads.metadata)
          where image.kind == .image && seen.insert(image.id).inserted {
            group.append(image)
          }
        }
      }
      if resolved.artifact.kind == .html {
        return Content(
          presentationID: id, artifact: resolved.artifact, images: group,
          contentURL: resolved.contentURL,
          htmlExpiresAt: resolved.expiresAt)
      }
      let kind = resolved.artifact.kind
      let isText = [.markdown, .text, .json, .csv].contains(kind)
      let (downloaded, file) = try await service.download(
        resolved, maximumSize: isText ? 2 * 1024 * 1024 : ChatAttachment.maximumSize)
      let text = isText ? try await ArtifactTextReader.shared.read(file, kind: kind) : nil
      return Content(
        presentationID: id, artifact: downloaded, images: group, file: file, text: text)
    } catch {
      if !closed, !Task.isCancelled { reportAccessFailure(error) }
      throw error
    }
  }

  func downloadForSharing() throws {
    guard !closed else { throw CancellationError() }
    downloadTask?.cancel()
    try store.set(requestDownload)
    _ = try store.get(download)
  }

  private func reportAccessFailure(_ error: Error) {
    if let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status) {
      didFail(error)
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    previewTask?.cancel()
    downloadTask?.cancel()
    previewTask = nil
    downloadTask = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    previewTask?.cancel()
    downloadTask?.cancel()
  }
}
