import ChatData
import ChatDomain
import Foundation
import Observation

/// One detail owns previews, catalog metadata and cancellation. No signed URL survives this scope.
@MainActor @Observable
final class MessageArtifactStore {
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

  private(set) var preview: MessageArtifactPreviewRead?
  private(set) var sharing: Share?
  private(set) var reads: MessageArtifactResources
  private let service: ChatArtifacts
  /// The chat whose artifact list supplies names and sizes; nil for a result opened from
  /// workspace search, which arrives with its own title.
  private let threadID: String?
  private let markdown: MessageMarkdownCache
  let webURL: URL
  var apiURL: URL { service.apiURL }
  private let didFail: @MainActor (Error) -> Void
  private var closed = false

  init(
    service: ChatArtifacts, threadID: String?, webURL: URL, markdown: MessageMarkdownCache,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.threadID = threadID
    self.webURL = webURL
    self.markdown = markdown
    self.didFail = didFail
    reads = MessageArtifactResources(
      service: service, threadID: threadID, webURL: webURL, didFail: didFail)
  }

  func resource(_ value: String) -> ChatArtifact? {
    ChatArtifactReference.parse(value, webURL: webURL, apiURL: service.apiURL)
  }

  func card(_ resource: ChatArtifact, thumbnail: Bool) async throws -> Card {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let owner = reads
    let read = owner.card(resource, thumbnail: thumbnail)
    let result = try await owner.store.get(read.value).value
    try Task.checkCancellation()
    guard !closed, reads === owner else { throw CancellationError() }
    return result
  }

  func open(
    _ resource: ChatArtifact, images: [ChatArtifact] = [], imageSources: [String] = [],
    renewedHTMLSignature: Bool = false, thumbnail: Data? = nil
  ) {
    guard !closed else { return }
    dismiss()
    let item = MessageArtifactPreviewRead(
      artifact: reads.metadata(resource), images: images, imageSources: imageSources,
      thumbnail: thumbnail, renewedHTMLSignature: renewedHTMLSignature,
      reads: reads, service: service, markdown: markdown, webURL: webURL, didFail: didFail)
    preview = item
    do { try item.start() } catch { didFail(error) }
  }

  func renewHTMLSignature(
    status: Int?, content: MessageArtifactPreviewRead.Content, previewID: UUID
  ) -> Bool {
    guard !closed, let item = preview, item.id == previewID, !item.renewedHTMLSignature else {
      return false
    }
    let expired = content.htmlExpiresAt.map { $0 <= Date() } ?? false
    guard [401, 403].contains(status ?? 0) || (status == 404 && expired) else { return false }
    switch content.artifact.source {
    case .reference, .file, .hostedSite:
      open(content.artifact, images: content.images, renewedHTMLSignature: true)
      return true
    case .published: return false
    }
  }

  func navigateImage(
    _ direction: Int, content: MessageArtifactPreviewRead.Content, previewID: UUID
  ) {
    guard !closed, preview?.id == previewID, let image = content.image(direction) else { return }
    open(image, images: content.images)
  }

  func share(_ file: ChatAttachmentFile, previewID: UUID) {
    guard !closed, preview?.id == previewID else { return }
    sharing = Share(file: file)
  }

  func dismissSharing() { sharing = nil }

  func downloadForSharing(previewID: UUID, retry: Bool = false) {
    guard !closed, let preview, preview.id == previewID else { return }
    do { try preview.downloadForSharing(retry: retry) } catch { didFail(error) }
  }

  func refreshDetails() {
    guard !closed, preview != nil else { return }
    do {
      try reads.refreshCatalog()
    } catch { didFail(error) }
  }

  func retry() {
    guard let preview else { return }
    do { try reads.refreshCatalog() } catch { didFail(error) }
    open(
      preview.artifact, images: preview.images, imageSources: preview.imageSources,
      thumbnail: preview.thumbnail)
  }

  func dismiss() {
    preview?.close()
    preview = nil
    sharing = nil
  }

  func deactivate() {
    dismiss()
    reads.close()
    if !closed {
      reads = MessageArtifactResources(
        service: service, threadID: threadID, webURL: webURL, didFail: didFail)
    }
  }

  func close() {
    closed = true
    deactivate()
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
