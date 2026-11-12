import CCState
import ChatData
import ChatDomain
import Foundation

/// A presentation owns its original preview and independent, explicitly requested share read.
@MainActor
final class MessageArtifactPreviewRead: Identifiable {
  struct Content: Sendable {
    let artifact: ChatArtifact
    let images: [ChatArtifact]
    var file: ChatAttachmentFile?
    var contentURL: URL?
    var htmlExpiresAt: Date?
    var text: ArtifactTextContent?

    func image(_ direction: Int) -> ChatArtifact? {
      guard let index = images.firstIndex(where: { $0.id == artifact.id }),
        images.indices.contains(index + direction)
      else { return nil }
      return images[index + direction]
    }
  }

  let id = UUID()
  let artifact: ChatArtifact
  let images: [ChatArtifact]
  let imageSources: [String]
  let thumbnail: Data?
  let loadsMetadata: Bool
  let renewedHTMLSignature: Bool
  let store: CCState.Store
  let reads: MessageArtifactResources
  private let service: ChatArtifacts
  private let markdown: MessageMarkdownCache
  private let uploadedFile: ChatAttachmentFile?
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
    renewedHTMLSignature: Bool, reads: MessageArtifactResources, service: ChatArtifacts,
    markdown: MessageMarkdownCache, webURL: URL, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.artifact = artifact
    self.images = images
    self.imageSources = imageSources
    self.thumbnail = thumbnail
    self.renewedHTMLSignature = renewedHTMLSignature
    self.reads = reads
    self.service = service
    self.markdown = markdown
    self.webURL = webURL
    self.didFail = didFail
    store = reads.store
    uploadedFile = service.uploadedFile(artifact)
    loadsMetadata = uploadedFile == nil || artifact.kind != .image || !imageSources.isEmpty
    let downloadRevision = downloadRevision
    requestDownload = Command { context in
      try context.set(downloadRevision, update: { $0 + 1 })
    }
  }

  lazy var value = makeValue()
  lazy var download = makeDownload()

  private func makeValue() -> Computed<Task<Content, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let signal = options.signal
      let task = Task { @MainActor [self] in
        let content = try await load()
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard !closed else { throw CancellationError() }
        return content
      }
      previewTask = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func makeDownload() -> Computed<Task<ChatAttachmentFile?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let requested = try get(downloadRevision) > 0
      let signal = options.signal
      let task = Task.immediate { @MainActor [self] in
        do {
          try Task.checkCancellation()
          guard requested else { return nil as ChatAttachmentFile? }
          // Preview rejection (including its 2 MiB text limit) never gates full-file sharing.
          let (_, file) = try await service.download(reads.metadata(artifact))
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

  private func load() async throws -> Content {
    try Task.checkCancellation()
    guard loadsMetadata else {
      return Content(
        artifact: artifact, images: images.map(reads.metadata).filter { $0.kind == .image },
        file: uploadedFile)
    }
    try await reads.prepareMetadata()
    try Task.checkCancellation()
    do {
      return try await loadAuthorizedContent()
    } catch {
      // Metadata reports its own access failures; report only this presentation's content I/O.
      if !closed, !Task.isCancelled { reportAccessFailure(error) }
      throw error
    }
  }

  private func loadAuthorizedContent() async throws -> Content {
    let resolved = try await service.resolve(reads.metadata(artifact))
    try Task.checkCancellation()
    var group = images.map(reads.metadata).filter { $0.kind == .image }
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
        where image.kind == .image && seen.insert(image.id).inserted { group.append(image) }
      }
    }
    if resolved.artifact.kind == .html {
      return Content(
        artifact: resolved.artifact, images: group, contentURL: resolved.contentURL,
        htmlExpiresAt: resolved.expiresAt)
    }
    let kind = resolved.artifact.kind
    let isText = [.markdown, .text, .json, .csv].contains(kind)
    let (downloaded, file) = try await service.download(
      resolved, maximumSize: isText ? 2 * 1024 * 1024 : ChatAttachment.maximumSize)
    let text = isText ? try await ArtifactTextReader.shared.read(file, kind: kind) : nil
    try Task.checkCancellation()
    return Content(artifact: downloaded, images: group, file: file, text: text)
  }

  func start() throws {
    guard !closed else { throw CancellationError() }
    _ = try store.get(value)
  }

  func downloadForSharing(retry: Bool = false) throws {
    guard !closed else { throw CancellationError() }
    if try store.get(downloadRevision) == 0 || retry {
      downloadTask?.cancel()
      try store.set(requestDownload)
    }
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
