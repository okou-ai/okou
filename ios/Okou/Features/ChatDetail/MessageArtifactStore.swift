import CCState
import ChatData
import ChatDomain
import Foundation

/// One detail owns previews, catalog metadata and cancellation. No signed URL survives this scope.
/// The open preview, its share sheet and the current reads are kept in the workspace session's
/// Store.
@MainActor
final class MessageArtifactStore {
  struct Share: Identifiable {
    let id = UUID()
    let file: ChatAttachmentFile
  }

  struct Card: Sendable {
    let artifact: ChatArtifact
    let thumbnail: Data?
    /// A website's own title, read while drawing its cover.
    var title: String?
  }

  /// What views present: the open preview, its share sheet, and the reads that cards and the
  /// preview use. References compare by identity.
  struct Presentation: Equatable {
    var preview: MessageArtifactPreviewRead?
    var sharing: Share?
    var reads: MessageArtifactResources

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.preview === rhs.preview && lhs.sharing?.id == rhs.sharing?.id && lhs.reads === rhs.reads
    }
  }

  /// Views resolve it; `preview`, `sharing` and `reads` serve actions and tests.
  let presentationValue: Computed<Presentation>
  /// The current reads alone, so transcript cards follow a replacement but not a preview.
  let readsValue: Computed<MessageArtifactResources>
  private let presentationState: CCState.State<Presentation>
  private let service: ChatArtifacts
  /// The chat whose artifact list supplies names and sizes; nil for a result opened from
  /// workspace search, which arrives with its own title.
  private let threadID: String?
  private let markdown: MessageMarkdownCache
  /// The workspace session's Store, which keeps the reads' graph values and the presentation.
  let graph: CCState.Store
  let webURL: URL
  var apiURL: URL { service.apiURL }
  private let didFail: @MainActor (Error) -> Void
  private var closed = false

  init(
    service: ChatArtifacts, threadID: String?, webURL: URL, markdown: MessageMarkdownCache,
    graph: CCState.Store, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.service = service
    self.threadID = threadID
    self.webURL = webURL
    self.markdown = markdown
    self.graph = graph
    self.didFail = didFail
    let presentationState = CCState.State(
      Presentation(
        reads: MessageArtifactResources(
          service: service, threadID: threadID, webURL: webURL, graph: graph, didFail: didFail)))
    self.presentationState = presentationState
    presentationValue = Computed { try $0(presentationState) }
    readsValue = Computed(equals: { $0 === $1 }, { get in try get(presentationState).reads })
  }

  var presentation: Presentation {
    // A synchronous local value, not a network or persistence boundary.
    do { return try graph.get(presentationValue) } catch {
      preconditionFailure("Cannot read the artifact viewer: \(error)")
    }
  }
  var preview: MessageArtifactPreviewRead? { presentation.preview }
  var sharing: Share? { presentation.sharing }
  var reads: MessageArtifactResources { presentation.reads }

  private func update(_ change: (inout Presentation) -> Void) {
    var next = presentation
    change(&next)
    guard next != presentation else { return }
    do { try graph.set(presentationState, next) } catch {
      preconditionFailure("Cannot publish the artifact viewer: \(error)")
    }
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
    update { $0.preview = item }
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
    case .publishedSite, .published: return false
    }
  }

  func navigateImage(
    _ direction: Int, content: MessageArtifactPreviewRead.Content, previewID: UUID,
    thumbnail: Data? = nil
  ) {
    guard !closed, preview?.id == previewID, let image = content.image(direction) else { return }
    open(image, images: content.images, thumbnail: thumbnail)
  }

  func share(_ file: ChatAttachmentFile, previewID: UUID) {
    guard !closed, preview?.id == previewID else { return }
    update { $0.sharing = Share(file: file) }
  }

  func dismissSharing() { update { $0.sharing = nil } }

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
    update {
      $0.preview = nil
      $0.sharing = nil
    }
  }

  func deactivate() {
    dismiss()
    reads.close()
    if !closed {
      let next = MessageArtifactResources(
        service: service, threadID: threadID, webURL: webURL, graph: graph, didFail: didFail)
      update { $0.reads = next }
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
