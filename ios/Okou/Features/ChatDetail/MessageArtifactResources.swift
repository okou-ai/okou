import CCState
import ChatData
import ChatDomain
import Foundation

/// One detail visit owns its metadata and keyed card reads, including cached failures.
@MainActor
final class MessageArtifactResources {
  private struct Key: Hashable {
    let artifact: ChatArtifact
    let thumbnail: Bool
  }

  /// The workspace session's Store, which keeps this visit's artifact reads.
  let store: CCState.Store
  fileprivate let lifetime = CCState.State(true)
  private let service: ChatArtifacts
  private let webURL: URL
  private let didFail: @MainActor (Error) -> Void
  private var cards: [Key: MessageArtifactCardRead] = [:]
  private var details: [ChatArtifact.Source: MessageArtifactDetailRead] = [:]
  private var closed = false

  init(
    service: ChatArtifacts, webURL: URL, graph: CCState.Store,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    store = graph
    self.service = service
    self.webURL = webURL
    self.didFail = didFail
  }

  func detail(_ artifact: ChatArtifact) -> MessageArtifactDetailRead {
    if let read = details[artifact.id] { return read }
    let read = MessageArtifactDetailRead(artifact: artifact, service: service, owner: self)
    details[artifact.id] = read
    return read
  }

  /// Definitions and results live for this visit, not for each mounted transcript row.
  func card(_ artifact: ChatArtifact, thumbnail: Bool) -> MessageArtifactCardRead {
    let key = Key(artifact: artifact, thumbnail: thumbnail)
    if let existing = cards[key] { return existing }
    let read = MessageArtifactCardRead(owner: self, artifact: artifact, thumbnail: thumbnail)
    cards[key] = read
    return read
  }

  func retry(_ read: MessageArtifactCardRead) {
    guard !closed else { return }
    do { try read.retry(in: store) } catch { didFail(error) }
  }

  func refreshDetail(_ artifact: ChatArtifact) throws {
    guard !closed else { throw CancellationError() }
    try detail(artifact).refresh(in: store)
  }

  func prepareMetadata(_ artifact: ChatArtifact) async throws {
    guard !closed else { throw CancellationError() }
    try await detail(artifact).prepare(in: store)
  }

  func metadata(_ artifact: ChatArtifact) -> ChatArtifact {
    guard let value = details[artifact.id]?.confirmed else { return artifact }
    return ChatArtifact(
      source: artifact.source, filename: value.filename, contentType: value.contentType,
      size: value.size, artifactKind: value.artifactKind, previewKind: value.previewKind,
      previewImageURL: value.previewImageURL)
  }

  fileprivate func loadCard(_ resource: ChatArtifact, thumbnail: Bool) async throws
    -> MessageArtifactStore.Card
  {
    // Refreshing file details must not download
    // every already displayed cover again. Each card has its own explicit retry.
    try await prepareMetadata(resource)
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let artifact = metadata(resource)
    do {
      if !thumbnail {
        let resolved = try await service.resolve(artifact)
        return MessageArtifactStore.Card(artifact: resolved.artifact, thumbnail: nil)
      }
      let (resolved, file) = try await service.thumbnail(artifact, webURL: webURL)
      var data: Data?
      if let file {
        data = await AttachmentFileImporter.shared.thumbnail(file.url, maximumPixelSize: 800)
      }
      if data == nil, resolved.kind == .video {
        let playback = try await service.resolve(resolved)
        data = try await ArtifactVideoPoster.shared.thumbnail(playback.contentURL)
      }
      if data == nil, resolved.kind == .html {
        let page = try await service.resolve(resolved)
        let snapshot = await SitePreviewSnapshotter.shared.snapshot(page.contentURL)
        return MessageArtifactStore.Card(
          artifact: resolved, thumbnail: snapshot?.image, title: snapshot?.title)
      }
      if data == nil, resolved.hasCover {
        // A missing/unreadable optional document cover keeps the existing file glyph.
        // Authentication and force-upgrade errors still belong to the workspace gate.
        do {
          let (_, document) = try await service.download(
            resolved, maximumSize: 25 * 1024 * 1024)
          data = await AttachmentFileImporter.shared.documentCover(document.url)
        } catch {
          try Task.checkCancellation()
          if Self.blocksAccess(error) { throw error }
        }
      }
      return MessageArtifactStore.Card(artifact: resolved, thumbnail: data)
    } catch {
      if !closed, !Task.isCancelled { reportAccessFailure(error) }
      throw error
    }
  }

  fileprivate static func blocksAccess(_ error: Error) -> Bool {
    guard let status = (error as? APIClientError)?.statusCode else { return false }
    return status == 401 || status == 426
  }

  fileprivate func reportAccessFailure(_ error: Error) {
    if Self.blocksAccess(error) { didFail(error) }
  }

  func close() {
    guard !closed else { return }
    closed = true
    for read in details.values { read.cancel() }
    details = [:]
    for read in cards.values { read.cancel() }
    cards = [:]
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

}

/// One stable artifact identity shares a metadata request between its header, cover and sheet.
@MainActor
final class MessageArtifactDetailRead {
  private let artifact: ChatArtifact
  private let service: ChatArtifacts
  private weak var owner: MessageArtifactResources?
  private let revision = CCState.State(0)
  private var request: (id: UUID, task: Task<ChatArtifact, Error>)?
  private(set) var confirmed: ChatArtifact?

  fileprivate init(
    artifact: ChatArtifact, service: ChatArtifacts, owner: MessageArtifactResources
  ) {
    self.artifact = artifact
    self.service = service
    self.owner = owner
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ChatArtifact, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, try get(owner.lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let id = UUID()
      let task = Task { @MainActor [weak self, artifact, service] in
        do {
          try Task.checkCancellation()
          let result = try await service.detail(artifact)
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard let self, request?.id == id else { throw CancellationError() }
          confirmed = result
          return result
        } catch {
          if self?.request?.id == id, !Task.isCancelled, !signal.isCancelled {
            self?.owner?.reportAccessFailure(error)
          }
          throw error
        }
      }
      request = (id, task)
      signal.onCancel { task.cancel() }
      return task
    }
  }

  fileprivate func prepare(in store: CCState.Store) async throws {
    while let owner, try store.get(owner.lifetime) {
      try Task.checkCancellation()
      let task = try store.get(value)
      let id = request?.id
      let result = await task.result
      try Task.checkCancellation()
      guard try store.get(owner.lifetime) else { throw CancellationError() }
      if request?.id != id { continue }
      if case .failure(let error) = result, MessageArtifactResources.blocksAccess(error) {
        throw error
      }
      return
    }
    throw CancellationError()
  }

  fileprivate func refresh(in store: CCState.Store) throws {
    cancel()
    try store.set(reload)
  }

  private lazy var reload: Command<Void, Void> = {
    let revision = revision
    return Command { context in try context.set(revision, update: { $0 + 1 }) }
  }()

  fileprivate func cancel() {
    request?.task.cancel()
    request = nil
    confirmed = nil
  }

  isolated deinit { request?.task.cancel() }
}

/// A shared original Task; releasing one row's waiter does not cancel its other consumers.
@MainActor
final class MessageArtifactCardRead {
  private weak var owner: MessageArtifactResources?
  private let artifact: ChatArtifact
  private let thumbnail: Bool
  private let revision = CCState.State(0)
  private let reload: Command<Void, Void>
  private var request: Task<MessageArtifactStore.Card, Error>?

  fileprivate init(owner: MessageArtifactResources, artifact: ChatArtifact, thumbnail: Bool) {
    self.owner = owner
    self.artifact = artifact
    self.thumbnail = thumbnail
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<MessageArtifactStore.Card, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, try get(owner.lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<MessageArtifactStore.Card, Error> { @MainActor [owner, artifact, thumbnail] in
        try Task.checkCancellation()
        let card = try await owner.loadCard(artifact, thumbnail: thumbnail)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return card
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
